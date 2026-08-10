// Función serverless de Vercel.
// Lemon Squeezy llama a esta dirección automáticamente cada vez que algo
// cambia en una suscripción (se crea, se renueva, se cancela, se vence).
// Aquí verificamos que el aviso sea realmente de Lemon Squeezy (usando la
// firma secreta), y actualizamos en Supabase si esa persona tiene acceso
// activo o no.

const crypto = require('crypto');

// Desactivamos el análisis automático del cuerpo de la solicitud, porque
// necesitamos el texto EXACTO tal como llegó (sin modificar ni un espacio)
// para poder comprobar la firma de seguridad correctamente.
module.exports.config = {
  api: { bodyParser: false }
};

function leerCuerpoCrudo(req) {
  return new Promise((resolve, reject) => {
    let datos = '';
    req.on('data', (fragmento) => { datos += fragmento; });
    req.on('end', () => resolve(datos));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const cuerpoCrudo = await leerCuerpoCrudo(req);

    // Verificar la firma: Lemon Squeezy firma cada aviso con nuestra clave
    // secreta. Si no coincide, alguien más está enviando esto (o hay un
    // error), y lo rechazamos sin hacer nada.
    const firmaRecibida = req.headers['x-signature'];
    const firmaEsperada = crypto
      .createHmac('sha256', process.env.LEMONSQUEEZY_WEBHOOK_SECRET)
      .update(cuerpoCrudo)
      .digest('hex');

    const firmaValida =
      firmaRecibida &&
      firmaRecibida.length === firmaEsperada.length &&
      crypto.timingSafeEqual(Buffer.from(firmaRecibida), Buffer.from(firmaEsperada));

    if (!firmaValida) {
      console.error('Firma de webhook inválida — solicitud rechazada.');
      res.status(401).json({ error: 'Firma inválida' });
      return;
    }

    const cuerpo = JSON.parse(cuerpoCrudo);
    const nombreEvento = cuerpo.meta && cuerpo.meta.event_name;
    const atributos = cuerpo.data && cuerpo.data.attributes;

    if (!nombreEvento || !atributos) {
      res.status(400).json({ error: 'Aviso incompleto' });
      return;
    }

    console.log('Webhook de Lemon Squeezy recibido:', nombreEvento);

    // Solo nos interesan los eventos de suscripción
    const eventosDeSuscripcion = [
      'subscription_created',
      'subscription_updated',
      'subscription_cancelled',
      'subscription_expired',
      'subscription_resumed',
      'subscription_unpaused'
    ];

    if (!eventosDeSuscripcion.includes(nombreEvento)) {
      res.status(200).json({ recibido: true, ignorado: true });
      return;
    }

    const correo = atributos.user_email;
    const estado = atributos.status; // active, on_trial, cancelled, expired, unpaid, past_due, paused
    const renuevaEl = atributos.renews_at;
    const terminaEl = atributos.ends_at;
    const idCliente = String(atributos.customer_id || '');
    const idSuscripcion = String(cuerpo.data.id || '');

    if (!correo) {
      console.error('El aviso no incluye el correo de la persona.');
      res.status(400).json({ error: 'Falta el correo en el aviso' });
      return;
    }

    // Un acceso se considera activo salvo que la suscripción ya haya
    // vencido o el pago haya fallado definitivamente.
    const activa = !['expired', 'unpaid'].includes(estado);
    const fechaFin = terminaEl || renuevaEl || null;

    // Actualizar el perfil en Supabase que tenga este correo, usando la
    // llave de servicio (acceso total, solo se usa aquí en el servidor).
    const respuestaSupabase = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(correo)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          suscripcion_activa: activa,
          suscripcion_fin: fechaFin,
          lemonsqueezy_customer_id: idCliente,
          lemonsqueezy_subscription_id: idSuscripcion
        })
      }
    );

    if (!respuestaSupabase.ok) {
      const detalleError = await respuestaSupabase.text().catch(() => '');
      console.error('Error actualizando Supabase:', respuestaSupabase.status, detalleError);
      res.status(500).json({ error: 'No se pudo actualizar el perfil en Supabase' });
      return;
    }

    const filasActualizadas = await respuestaSupabase.json();
    if (!filasActualizadas || filasActualizadas.length === 0) {
      // No existe todavía un perfil con ese correo — puede pasar si la
      // persona pagó antes de crear su cuenta en la app, o con un correo
      // distinto al de su cuenta. Lo registramos para poder revisarlo.
      console.error(`No se encontró ningún perfil con el correo: ${correo}`);
    }

    res.status(200).json({ recibido: true, actualizado: filasActualizadas.length > 0 });
  } catch (error) {
    console.error('Error en el webhook de Lemon Squeezy:', error);
    res.status(500).json({ error: 'Error interno del servidor: ' + (error && error.message) });
  }
};
