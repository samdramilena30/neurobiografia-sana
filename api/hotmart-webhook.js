// Función serverless de Vercel.
// Hotmart llama a esta dirección automáticamente cada vez que algo cambia
// en una compra o suscripción (se aprueba, se cancela, se reembolsa, etc.).
// A diferencia de Lemon Squeezy, Hotmart no firma el mensaje con una huella
// criptográfica — en su lugar, incluye el "Hottok" (tu clave secreta) en el
// propio aviso, y basta con comprobar que coincida con el nuestro.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  try {
    const cuerpo = req.body;

    if (!cuerpo || typeof cuerpo !== 'object') {
      res.status(400).json({ error: 'Aviso vacío o mal formado' });
      return;
    }

    // El Hottok puede llegar dentro del cuerpo del mensaje o en un
    // encabezado, según la versión — comprobamos ambos lugares posibles.
    const hottokRecibido =
      cuerpo.hottok ||
      req.headers['x-hotmart-hottok'] ||
      req.headers['x-hotmart-signature'];

    if (!hottokRecibido || hottokRecibido !== process.env.HOTMART_HOTTOK) {
      console.error('Hottok inválido o ausente — aviso rechazado.');
      res.status(401).json({ error: 'Hottok inválido' });
      return;
    }

    const nombreEvento = cuerpo.event;
    const datos = cuerpo.data;

    if (!nombreEvento || !datos) {
      res.status(400).json({ error: 'Aviso incompleto' });
      return;
    }

    console.log('Webhook de Hotmart recibido:', nombreEvento);

    const correo =
      (datos.buyer && datos.buyer.email) ||
      (datos.subscriber && datos.subscriber.email);

    if (!correo) {
      console.error('El aviso no incluye el correo de la persona.');
      res.status(400).json({ error: 'Falta el correo en el aviso' });
      return;
    }

    // Eventos que ACTIVAN el acceso
    const eventosDeActivacion = [
      'PURCHASE_APPROVED',
      'PURCHASE_COMPLETE',
      'SUBSCRIPTION_REACTIVATION'
    ];

    // Eventos que QUITAN el acceso
    const eventosDeDesactivacion = [
      'PURCHASE_CANCELED',
      'PURCHASE_REFUNDED',
      'PURCHASE_CHARGEBACK',
      'PURCHASE_EXPIRED',
      'PURCHASE_PROTEST',
      'SUBSCRIPTION_CANCELLATION'
    ];

    let activa = null;
    if (eventosDeActivacion.includes(nombreEvento)) activa = true;
    if (eventosDeDesactivacion.includes(nombreEvento)) activa = false;

    // Si el estado de la suscripción viene incluido, lo usamos como
    // confirmación adicional (más confiable que solo el nombre del evento).
    const estadoSuscripcion = datos.subscription && datos.subscription.status;
    if (estadoSuscripcion) {
      activa = estadoSuscripcion === 'ACTIVE' || estadoSuscripcion === 'STARTED';
    }

    if (activa === null) {
      // Evento que no nos interesa para el acceso (ej. carrito abandonado)
      res.status(200).json({ recibido: true, ignorado: true });
      return;
    }

    const codigoSuscriptor =
      (datos.subscription && datos.subscription.subscriber && datos.subscription.subscriber.code) || '';
    const transaccion = (datos.purchase && datos.purchase.transaction) || '';

    // Calcular hasta cuándo tiene acceso, si Hotmart lo informa
    const fechaFin =
      (datos.subscription && datos.subscription.date_next_charge) || null;

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
          hotmart_subscriber_code: codigoSuscriptor,
          hotmart_transaction: transaccion
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
      // No existe todavía un perfil con ese correo — la persona pagó antes
      // de crear su cuenta en la app. En vez de perder este pago, lo
      // guardamos en espera: en cuanto cree su cuenta, un disparador en
      // Supabase lo aplica automáticamente.
      console.log(`No se encontró perfil con ${correo} — guardando el pago en espera.`);

      const respuestaEspera = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/pending_subscriptions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            email: correo,
            suscripcion_activa: activa,
            suscripcion_fin: fechaFin,
            hotmart_subscriber_code: codigoSuscriptor,
            hotmart_transaction: transaccion
          })
        }
      );

      if (!respuestaEspera.ok) {
        const detalleError = await respuestaEspera.text().catch(() => '');
        console.error('Error guardando el pago en espera:', respuestaEspera.status, detalleError);
      }
    }

    res.status(200).json({ recibido: true, actualizado: filasActualizadas.length > 0 });
  } catch (error) {
    console.error('Error en el webhook de Hotmart:', error);
    res.status(500).json({ error: 'Error interno del servidor: ' + (error && error.message) });
  }
};
