const ALLOWED_ORIGINS = new Set([
  'https://shudhsanjivani.in',
  'https://www.shudhsanjivani.in'
]);

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://shudhsanjivani.in';
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(origin) });
}

function cleanString(v, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

function cleanDigits(v, max = 20) {
  return String(v ?? '').replace(/\D/g, '').slice(0, max);
}

async function createOrder(request, env) {
  const origin = request.headers.get('Origin') || '';
  try {
    const body = await request.json();
    const amount = Number(body?.amount);
    const receipt = cleanString(body?.receipt, 40);

    if (!Number.isInteger(amount) || amount < 100)
      return json({ error: 'Invalid amount' }, 400, origin);

    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)
      return json({ error: 'Razorpay keys are not configured on the server.' }, 500, origin);

    const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);

    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount,
        currency: 'INR',
        receipt,
        notes: { source: 'shudh-sanjivani-website' }
      })
    });

    const data = await r.json();

    if (!r.ok)
      return json({
        error: data?.error?.description || 'Razorpay order creation failed.'
      }, 502, origin);

    return json({
      order_id: data.id,
      amount: data.amount,
      currency: data.currency,
      key_id: env.RAZORPAY_KEY_ID
    }, 200, origin);

  } catch (e) {
    return json({ error: 'Invalid request.' }, 400, origin);
  }
}
async function verifyPayment(request, env) {
  const origin = request.headers.get('Origin') || '';

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = await request.json();

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !env.RAZORPAY_KEY_SECRET
    ) {
      return json(
        { verified: false, error: 'Missing payment verification data.' },
        400,
        origin
      );
    }

    const enc = new TextEncoder();

    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(env.RAZORPAY_KEY_SECRET),
      {
        name: 'HMAC',
        hash: 'SHA-256'
      },
      false,
      ['sign']
    );

    const sig = await crypto.subtle.sign(
      'HMAC',
      key,
      enc.encode(`${razorpay_order_id}|${razorpay_payment_id}`)
    );

    const expected = [...new Uint8Array(sig)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const verified = expected === razorpay_signature;

    return json(
      { verified },
      verified ? 200 : 400,
      origin
    );

  } catch (e) {
    return json(
      { verified: false, error: 'Verification failed.' },
      400,
      origin
    );
  }
}

function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}
function escapeHtml(v){
  return String(v??'').replace(/[&<>"']/g,c=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

function orderText(order){
  const items=(order.items||[])
    .map(x=>`• ${x.name} — ${x.size} × ${x.qty} = ₹${Number(x.total||0).toLocaleString('en-IN')}`)
    .join('\n');

  return `Order ID: ${order.id}
Customer: ${order.customer?.name||''}
Mobile: ${order.customer?.phone||''}
Address: ${[order.customer?.address,order.customer?.city,order.customer?.pincode].filter(Boolean).join(', ')}
Payment: ${order.paymentMethod||''}
Payment Status: ${order.paymentStatus||''}
Subtotal: ₹${Number(order.subtotal||0).toLocaleString('en-IN')}
Delivery: ₹${Number(order.delivery||0).toLocaleString('en-IN')}
Total: ₹${Number(order.total||0).toLocaleString('en-IN')}
Fresh grinding: ${order.freshGrinding?'Yes':'No'}

Items:
${items}`;
}

async function sendOrderEmail(order, env){
  if(!env.RESEND_API_KEY || !env.ORDER_EMAIL_TO || !env.ORDER_EMAIL_FROM)
    return {status:'not_configured'};

  const text=orderText(order);

  const html=`<h2>New Shudh Sanjivani Order</h2>
  <p><b>Order ID:</b> ${escapeHtml(order.id)}</p>
  <p><b>Customer:</b> ${escapeHtml(order.customer?.name)}
  <br><b>Mobile:</b> ${escapeHtml(order.customer?.phone)}
  <br><b>Address:</b> ${escapeHtml([order.customer?.address,order.customer?.city,order.customer?.pincode].filter(Boolean).join(', '))}</p>
  <p><b>Payment:</b> ${escapeHtml(order.paymentMethod)}
  <br><b>Status:</b> ${escapeHtml(order.paymentStatus)}</p>
  <p><b>Subtotal:</b> ₹${Number(order.subtotal||0).toLocaleString('en-IN')}
  <br><b>Delivery:</b> ₹${Number(order.delivery||0).toLocaleString('en-IN')}
  <br><b>Total:</b> ₹${Number(order.total||0).toLocaleString('en-IN')}</p>
  <h3>Items</h3>
  <ul>${(order.items||[]).map(x=>`<li>${escapeHtml(x.name)} — ${escapeHtml(x.size)} × ${x.qty} = ₹${Number(x.total||0).toLocaleString('en-IN')}</li>`).join('')}</ul>`;

  const resp=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{
      Authorization:`Bearer ${env.RESEND_API_KEY}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      from:env.ORDER_EMAIL_FROM,
      to:[env.ORDER_EMAIL_TO],
      subject:`New Order ${order.id} — Shudh Sanjivani`,
      html,
      text,
      headers:{'Idempotency-Key':order.id}
    })
  });

  if(!resp.ok) throw new Error(`Email provider returned ${resp.status}`);
  return {status:'sent'};
}async function sendOwnerSms(order, env){
  if(!env.MSG91_AUTHKEY || !env.MSG91_TEMPLATE_ID || !env.MSG91_OWNER_MOBILE) return {status:'not_configured'};
  const mobile='91'+cleanDigits(env.MSG91_OWNER_MOBILE,10).slice(-10);
  const payload={template_id:env.MSG91_TEMPLATE_ID,short_url:'0',realTimeResponse:'1',CRQID:order.id,recipients:[{mobiles:mobile,var1:order.id,var2:order.customer?.name||'',var3:String(Math.round(order.total||0)),var4:order.paymentMethod||''}]};
  const resp=await fetch('https://control.msg91.com/api/v5/flow',{method:'POST',headers:{accept:'application/json',authkey:env.MSG91_AUTHKEY,'content-type':'application/json'},body:JSON.stringify(payload)});
  if(!resp.ok) throw new Error(`SMS provider returned ${resp.status}`);
  const data=await resp.json().catch(()=>({}));
  if(data?.type==='error') throw new Error(data.message||'SMS provider error');
  return {status:'sent'};
}
async function notifyNewOrder(order, env){
  const [email,sms]=await Promise.allSettled([sendOrderEmail(order,env),sendOwnerSms(order,env)]);
  return {email:email.status==='fulfilled'?email.value.status:'failed',sms:sms.status==='fulfilled'?sms.value.status:'failed'};
}

async function saveOrder(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!env.ORDERS_KV) return json({ saved: false, error: 'Order storage is not configured yet.' }, 503, origin);
  try {
    const body = await request.json();
    const order = body?.order;
    if (!order || !cleanString(order.id, 60)) return json({ saved: false, error: 'Invalid order data.' }, 400, origin);
    const normalized = {
      id: cleanString(order.id, 60),
      createdAt: cleanString(order.createdAt, 60) || new Date().toISOString(),
      paymentMethod: cleanString(order.paymentMethod, 30),
      paymentStatus: cleanString(order.paymentStatus, 120),
      razorpayPaymentId: cleanString(order.razorpayPaymentId, 80),
      razorpayOrderId: cleanString(order.razorpayOrderId, 80),
      subtotal: Number(order.subtotal) || 0,
      delivery: Number(order.delivery) || 0,
      total: Number(order.total) || 0,
      freshGrinding: !!order.freshGrinding,
      customer: {
        name: cleanString(order.customer?.name, 120),
        phone: cleanDigits(order.customer?.phone, 15),
        address: cleanString(order.customer?.address, 500),
        city: cleanString(order.customer?.city, 120),
        pincode: cleanDigits(order.customer?.pincode, 6),
        note: cleanString(order.customer?.note, 500)
      },
      items: Array.isArray(order.items) ? order.items.slice(0, 50).map(x => ({
        name: cleanString(x?.name, 160), size: cleanString(x?.size, 50), qty: Math.max(1, Number(x?.qty) || 1), price: Number(x?.price) || 0, total: Number(x?.total) || 0
      })) : []
    };
    await env.ORDERS_KV.put(`order:${normalized.id}`, JSON.stringify(normalized));
    const notifications=await notifyNewOrder(normalized,env);
    return json({ saved: true, orderId: normalized.id, notifications }, 200, origin);
  } catch (e) { return json({ saved: false, error: 'Order could not be saved.' }, 400, origin); }
}
async function listOrders(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401, origin);
  if (!env.ORDERS_KV) return json({ error: 'Order storage is not configured yet.' }, 503, origin);
  try {
    const listed = await env.ORDERS_KV.list({ prefix: 'order:', limit: 1000 });
    const orders = [];
    for (const key of listed.keys) {
      const raw = await env.ORDERS_KV.get(key.name);
      if (raw) { try { orders.push(JSON.parse(raw)); } catch (e) {} }
    }
    orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json({ orders }, 200, origin);
  } catch (e) { return json({ error: 'Orders could not be loaded.' }, 500, origin); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (url.pathname === '/api/razorpay/create-order' && request.method === 'POST') return createOrder(request, env);
    if (url.pathname === '/api/razorpay/verify-payment' && request.method === 'POST') return verifyPayment(request, env);
    if (url.pathname === '/api/orders/save' && request.method === 'POST') return saveOrder(request, env);
    if (url.pathname === '/api/admin/orders' && request.method === 'GET') return listOrders(request, env);
    const assetResponse = await env.ASSETS.fetch(request);
    // Stage 96: prevent the production HTML from being served from an older edge/browser cache.
    // This is important while deploying the checkout/order-flow fix.
    const headers = new Headers(assetResponse.headers);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      headers.set('Pragma', 'no-cache');
      headers.set('Expires', '0');
    }
    return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
  }
};
