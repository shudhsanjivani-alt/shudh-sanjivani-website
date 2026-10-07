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
function cleanString(v, max = 500) { return String(v ?? '').trim().slice(0, max); }
function cleanDigits(v, max = 20) { return String(v ?? '').replace(/\D/g, '').slice(0, max); }

async function createOrder(request, env) {
  const origin = request.headers.get('Origin') || '';
  try {
    const body = await request.json();
    const amount = Number(body?.amount);
    const receipt = cleanString(body?.receipt, 40);
    if (!Number.isInteger(amount) || amount < 100) return json({ error: 'Invalid amount' }, 400, origin);
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return json({ error: 'Razorpay keys are not configured on the server.' }, 500, origin);
    const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, currency: 'INR', receipt, notes: { source: 'shudh-sanjivani-website' } })
    });
    const data = await r.json();
    if (!r.ok) return json({ error: data?.error?.description || 'Razorpay order creation failed.' }, 502, origin);
    return json({ order_id: data.id, amount: data.amount, currency: data.currency, key_id: env.RAZORPAY_KEY_ID }, 200, origin);
  } catch (e) { return json({ error: 'Invalid request.' }, 400, origin); }
}

async function verifyPayment(request, env) {
  const origin = request.headers.get('Origin') || '';
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await request.json();
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !env.RAZORPAY_KEY_SECRET) return json({ verified: false, error: 'Missing payment verification data.' }, 400, origin);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(env.RAZORPAY_KEY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${razorpay_order_id}|${razorpay_payment_id}`));
    const expected = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    const verified = expected === razorpay_signature;
    return json({ verified }, verified ? 200 : 400, origin);
  } catch (e) { return json({ verified: false, error: 'Verification failed.' }, 400, origin); }
}

function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}


function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function orderText(order){
  const items=(order.items||[]).map(x=>`• ${x.name} — ${x.size} × ${x.qty} = ₹${Number(x.total||0).toLocaleString('en-IN')}`).join('\n');
  return `Order ID: ${order.id}\nCustomer: ${order.customer?.name||''}\nMobile: ${order.customer?.phone||''}\nAddress: ${[order.customer?.address,order.customer?.city,order.customer?.pincode].filter(Boolean).join(', ')}\nPayment: ${order.paymentMethod||''}\nPayment Status: ${order.paymentStatus||''}\nSubtotal: ₹${Number(order.subtotal||0).toLocaleString('en-IN')}\nDelivery: ₹${Number(order.delivery||0).toLocaleString('en-IN')}\nTotal: ₹${Number(order.total||0).toLocaleString('en-IN')}\nFresh grinding: ${order.freshGrinding?'Yes':'No'}\n\nItems:\n${items}`;
}
async function sendOrderEmail(order, env){
  if(!env.RESEND_API_KEY || !env.ORDER_EMAIL_TO || !env.ORDER_EMAIL_FROM) return {status:'not_configured'};
  const text=orderText(order);
  const html=`<h2>New Shudh Sanjivani Order</h2><p><b>Order ID:</b> ${escapeHtml(order.id)}</p><p><b>Customer:</b> ${escapeHtml(order.customer?.name)}<br><b>Mobile:</b> ${escapeHtml(order.customer?.phone)}<br><b>Address:</b> ${escapeHtml([order.customer?.address,order.customer?.city,order.customer?.pincode].filter(Boolean).join(', '))}</p><p><b>Payment:</b> ${escapeHtml(order.paymentMethod)}<br><b>Status:</b> ${escapeHtml(order.paymentStatus)}</p><p><b>Subtotal:</b> ₹${Number(order.subtotal||0).toLocaleString('en-IN')}<br><b>Delivery:</b> ₹${Number(order.delivery||0).toLocaleString('en-IN')}<br><b>Total:</b> ₹${Number(order.total||0).toLocaleString('en-IN')}</p><h3>Items</h3><ul>${(order.items||[]).map(x=>`<li>${escapeHtml(x.name)} — ${escapeHtml(x.size)} × ${x.qty} = ₹${Number(x.total||0).toLocaleString('en-IN')}</li>`).join('')}</ul>`;
  const resp=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.ORDER_EMAIL_FROM,to:[env.ORDER_EMAIL_TO],subject:`New Order ${order.id} — Shudh Sanjivani`,html,text,headers:{'Idempotency-Key':order.id}})});
  if(!resp.ok) throw new Error(`Email provider returned ${resp.status}`);
  return {status:'sent'};
}
async function sendOwnerSms(order, env){
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


async function shiprocketToken(env) {
  if (!env.SHIPROCKET_EMAIL || !env.SHIPROCKET_PASSWORD) return null;
  const resp = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({email: env.SHIPROCKET_EMAIL, password: env.SHIPROCKET_PASSWORD})
  });
  const data = await resp.json().catch(()=>({}));
  if (!resp.ok || !data?.token) throw new Error('Shiprocket authentication failed');
  return data.token;
}

async function createShiprocketOrder(order, env) {
  if (!env.SHIPROCKET_EMAIL || !env.SHIPROCKET_PASSWORD) return {status:'not_configured'};
  const token = await shiprocketToken(env);
  const customer = order.customer || {};
  const names = String(customer.name || 'Customer').trim().split(/\s+/);
  const firstName = names.shift() || 'Customer';
  const lastName = names.join(' ') || 'Customer';
  const items = (order.items || []).slice(0,50).map((x,i)=>({
    name: cleanString(x?.name,120) || `Product ${i+1}`,
    sku: cleanString(`${x?.name||'product'}-${x?.size||''}`.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),60) || `product-${i+1}`,
    units: Math.max(1, Number(x?.qty)||1),
    selling_price: Number(x?.price)||0,
    discount: 0,
    tax: 0,
    hsn: ''
  }));
  const paymentMethod = String(order.paymentMethod||'cod').toLowerCase()==='cod' ? 'COD' : 'Prepaid';
  const payload = {
    order_id: order.id,
    order_date: new Date(order.createdAt || Date.now()).toISOString().slice(0,19).replace('T',' '),
    pickup_location: 'Home',
    channel_id: '',
    comment: order.freshGrinding ? 'Fresh grinding / fresh packing requested.' : '',
    billing_customer_name: firstName,
    billing_last_name: lastName,
    billing_address: cleanString(customer.address,500),
    billing_address_2: '',
    billing_city: cleanString(customer.city,120),
    billing_pincode: cleanDigits(customer.pincode,6),
    billing_state: 'Punjab',
    billing_country: 'India',
    billing_email: env.ORDER_EMAIL_TO || 'shudhsanjivani@gmail.com',
    billing_phone: cleanDigits(customer.phone,15),
    shipping_is_billing: true,
    shipping_customer_name: firstName,
    shipping_last_name: lastName,
    shipping_address: cleanString(customer.address,500),
    shipping_address_2: '',
    shipping_city: cleanString(customer.city,120),
    shipping_pincode: cleanDigits(customer.pincode,6),
    shipping_country: 'India',
    shipping_state: 'Punjab',
    shipping_email: env.ORDER_EMAIL_TO || 'shudhsanjivani@gmail.com',
    shipping_phone: cleanDigits(customer.phone,15),
    order_items: items,
    payment_method: paymentMethod,
    shipping_charges: Number(order.delivery)||0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: 0,
    sub_total: Number(order.subtotal)||0,
    length: 20,
    breadth: 15,
    height: 10,
    weight: 0.5
  };
  const resp = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', {
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  const data = await resp.json().catch(()=>({}));
  if (!resp.ok || data?.status_code === 400 || data?.status === 0) {
    throw new Error(data?.message || 'Shiprocket order creation failed');
  }
  return {status:'created', shiprocketOrderId:data?.order_id || null, shipmentId:data?.shipment_id || null};
}

async function trackShipment(request, env) {
  const origin = request.headers.get('Origin') || '';
  const url = new URL(request.url);
  const awb = String(url.searchParams.get('awb') || '').replace(/[^A-Za-z0-9_-]/g,'').slice(0,40);
  if (!awb) return json({ ok:false, error:'Tracking ID required.' }, 400, origin);
  if (!env.SHIPROCKET_EMAIL || !env.SHIPROCKET_PASSWORD) return json({ ok:false, error:'Shipping tracking is not configured yet.' }, 503, origin);
  try {
    const token = await shiprocketToken(env);
    const resp = await fetch('https://apiv2.shiprocket.in/v1/external/courier/track/awb/' + encodeURIComponent(awb), { headers: { Authorization: 'Bearer ' + token } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return json({ ok:false, error:data?.message || 'Tracking service could not be reached.' }, resp.status >= 400 && resp.status < 500 ? resp.status : 502, origin);
    const td = data?.tracking_data || {};
    const tracks = Array.isArray(td?.shipment_track) ? td.shipment_track : [];
    const activities = Array.isArray(td?.shipment_track_activities) ? td.shipment_track_activities : [];
    return json({ ok:true, tracking_id:awb, courier:tracks[0]?.courier_name || td?.courier_name || 'Courier', status:tracks[0]?.current_status || td?.shipment_status || 'Tracking available', etd:tracks[0]?.etd || td?.etd || null, activities:activities.slice(0,30).map(a=>({date:a?.date||null,status:a?.status||a?.activity||null,location:a?.location||null})) },200,origin);
  } catch (e) { return json({ ok:false, error:'Tracking could not be loaded right now.' },502,origin); }
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
    let shiprocket={status:'not_configured'};
    try { shiprocket=await createShiprocketOrder(normalized,env); } catch (e) { shiprocket={status:'failed',error:String(e?.message||'Shiprocket error')}; }
    return json({ saved: true, orderId: normalized.id, notifications, shiprocket }, 200, origin);
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


async function listReviews(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!env.ORDERS_KV) return json({ error: 'Review storage is not configured yet.' }, 503, origin);
  try {
    const listed = await env.ORDERS_KV.list({ prefix: 'review:', limit: 1000 });
    const reviews = [];
    for (const key of listed.keys) {
      const raw = await env.ORDERS_KV.get(key.name);
      if (raw) { try { const r = JSON.parse(raw); if (r && r.product && Number(r.rating) >= 1) reviews.push(r); } catch (e) {} }
    }
    reviews.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    return json({ reviews: reviews.slice(0, 300) }, 200, origin);
  } catch (e) { return json({ error: 'Reviews could not be loaded.' }, 500, origin); }
}

async function saveReview(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!env.ORDERS_KV) return json({ saved: false, error: 'Review storage is not configured yet.' }, 503, origin);
  try {
    const body = await request.json();
    const product = cleanString(body?.product, 160);
    const name = cleanString(body?.name, 80) || 'ग्राहक';
    const text = cleanString(body?.text, 500);
    const rating = Math.max(1, Math.min(5, Math.round(Number(body?.rating) || 0)));
    const clientId = cleanString(body?.clientId, 100).replace(/[^a-zA-Z0-9_-]/g,'');
    if (!product || !rating || !clientId) return json({ saved: false, error: 'समीक्षा की जानकारी पूरी नहीं है।' }, 400, origin);
    const review = { product, name, text, rating, clientId, createdAt: new Date().toISOString() };
    await env.ORDERS_KV.put(`review:${product}:${clientId}`, JSON.stringify(review));
    const listed = await env.ORDERS_KV.list({ prefix: 'review:', limit: 1000 });
    const reviews = [];
    for (const key of listed.keys) {
      const raw = await env.ORDERS_KV.get(key.name);
      if (raw) { try { const r=JSON.parse(raw); if (r && r.product===product && Number(r.rating)>=1) reviews.push(r); } catch(e){} }
    }
    reviews.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    return json({ saved: true, review, reviews: reviews.slice(0, 50) }, 200, origin);
  } catch (e) { return json({ saved: false, error: 'समीक्षा server पर सेव नहीं हो सकी।' }, 400, origin); }
}

// Stage: Festival Pack homepage image + details are intentionally kept in Preview only.
function applySeo(response, isHomepage = false) {
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('text/html')) return response;
  let hasDescription=false, hasRobots=false, hasCanonical=false, hasOgTitle=false, hasOgDescription=false, hasOgUrl=false;
  let redChilliCardCount = 0;
  const seo = {
    title: 'Shudh Sanjivani | Pure Spices & Natural Products',
    description: 'Pure masale, Pure Spices, Whole Spices & Premium Sets और Natural Products — रोज़मर्रा की रसोई के लिए खालिस मसाले, पारंपरिक स्वाद और भरोसा।'
  };
  return new HTMLRewriter()
    .on('section[aria-label="लाल मिर्च ब्लॉग"]', { element(el) {
      if (isHomepage) {
        redChilliCardCount += 1;
        if (redChilliCardCount > 1) el.remove();
      }
    }})
    .on('title', { element(el) { el.setInnerContent(seo.title); } })
    .on('meta', { element(el) {
      const name=String(el.getAttribute('name')||'').toLowerCase();
      const property=String(el.getAttribute('property')||'').toLowerCase();
      if(name==='description'){hasDescription=true;el.setAttribute('content',seo.description);}
      if(name==='robots'){hasRobots=true;el.setAttribute('content','index, follow');}
      if(property==='og:title'){hasOgTitle=true;el.setAttribute('content',seo.title);}
      if(property==='og:description'){hasOgDescription=true;el.setAttribute('content',seo.description);}
      if(property==='og:url'){hasOgUrl=true;el.setAttribute('content','https://shudhsanjivani.in/');}
    }})
    .on('link', { element(el) {
      const rel=String(el.getAttribute('rel')||'').toLowerCase().split(/\s+/);
      if(rel.includes('canonical')){hasCanonical=true;el.setAttribute('href','https://shudhsanjivani.in/');}
    }})
    .on('section[aria-label="Shudh Sanjivani Festival Pack"], section.festival-pack', { element(el) {
      if (isHomepage) el.remove();
    }})

    .on('body', { element(el) {
      if (!isHomepage) return;
      el.prepend(`
<style>
.festival-pack-stage-card{max-width:1120px;margin:0 auto 34px;padding:0 18px}
.festival-pack-stage-inner{border:1px solid #d8c7a9;border-radius:20px;background:linear-gradient(135deg,#fffdf8,#f8f0df);box-shadow:0 10px 30px rgba(54,45,30,.09);overflow:hidden}
.festival-pack-stage-head{padding:24px 22px 16px;text-align:center;background:linear-gradient(180deg,#fffaf0,#f7ead5)}
.festival-pack-stage-kicker{display:inline-block;padding:6px 12px;border-radius:999px;background:#a9653f;color:#fff;font:800 11px Arial,sans-serif;letter-spacing:1.1px}
.festival-pack-stage-head h2{margin:10px 0 5px;border:0;padding:0;color:#43513d;font-size:30px}
.festival-pack-stage-head p{margin:0;color:#687064;font-size:15px}
.festival-pack-stage-body{display:grid;grid-template-columns:1fr 1.35fr;gap:22px;padding:22px}
.festival-pack-stage-visual{border-radius:16px;min-height:260px;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:radial-gradient(circle at 50% 35%,#fffdf8 0,#eee4cf 52%,#d9c7a8 100%);border:1px solid #e0d3be}.festival-pack-stage-visual img{display:block;width:100%;max-width:430px;height:auto;max-height:430px;object-fit:contain;border-radius:12px;margin:0 auto;box-shadow:0 5px 18px rgba(54,45,30,.08)}
.festival-pack-stage-visual strong{display:block;font:900 54px/1 Arial,sans-serif;color:#8e2f1c}
.festival-pack-stage-visual span{display:block;margin-top:10px;font:800 18px/1.35 Arial,sans-serif;color:#43513d}
.festival-pack-stage-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin:0;padding:0;list-style:none}
.festival-pack-stage-list li{padding:8px 9px;border:1px solid #e5dac8;border-radius:9px;background:#fff;font:700 12px/1.35 Arial,sans-serif;color:#4f574d}
.festival-pack-stage-list li b{color:#a9653f}
.festival-pack-stage-bottom{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px;padding-top:14px;border-top:1px solid #e2d6c3}
.festival-pack-stage-price{font:900 27px Arial,sans-serif;color:#8e2f1c}
.festival-pack-stage-free{font:800 12px Arial,sans-serif;color:#287a45;margin-top:3px}
.festival-pack-stage-cart{border:0;border-radius:10px;min-height:48px;padding:0 20px;background:#a9653f;color:#fff;font:800 14px Arial,sans-serif;cursor:pointer;box-shadow:0 5px 14px rgba(169,101,63,.18)}
.festival-pack-stage-cart:hover{filter:brightness(.94)}
@media(max-width:700px){
  .festival-pack-stage-card{padding:0 12px}
  .festival-pack-stage-body{grid-template-columns:1fr;padding:16px}
  .festival-pack-stage-visual{min-height:170px}
  .festival-pack-stage-visual strong{font-size:44px}
  .festival-pack-stage-head h2{font-size:25px}
  .festival-pack-stage-list{grid-template-columns:1fr 1fr;gap:7px}
  .festival-pack-stage-list li{font-size:11px}
  .festival-pack-stage-bottom{display:block}
  .festival-pack-stage-cart{width:100%;margin-top:12px}
}
</style>
<section id="festival-pack" aria-label="Festival Pack" class="festival-pack-stage-card">
  <div class="festival-pack-stage-inner">
    <div class="festival-pack-stage-head">
      <span class="festival-pack-stage-kicker">SPECIAL COMBO</span>
      <h2>Shudh Sanjivani Festival Pack</h2>
      <p>15 Spice Combo Pack — एक पैक मसालों की असली खुशबू वाला</p>
    </div>
    <div class="festival-pack-stage-body">
      <div class="festival-pack-stage-visual">
        <img src="data:image/webp;base64,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" alt="Shudh Sanjivani 15 Spice Combo Pack — सभी 15 मसाले, ₹799, Delivery Free" style="width:100%;height:auto;max-height:620px;object-fit:contain;border-radius:14px;display:block" loading="eager" decoding="async"/>
      </div>
      <div>
        <ul class="festival-pack-stage-list">
          <li>हल्दी पाउडर <b>100g</b></li>
          <li>लाल मिर्च पाउडर <b>100g</b></li>
          <li>धनिया पाउडर <b>100g</b></li>
          <li>जीरा <b>100g</b></li>
          <li>काली मिर्च <b>40g</b></li>
          <li>गरम मसाला <b>80g</b></li>
          <li>चाय मसाला <b>40g</b></li>
          <li>चाट मसाला <b>40g</b></li>
          <li>कसूरी मेथी <b>50g</b></li>
          <li>हरी इलायची <b>15g</b></li>
          <li>सौंफ <b>100g</b></li>
          <li>अजवाइन <b>50g</b></li>
          <li>लौंग <b>20g</b></li>
          <li>सौंठ पाउडर <b>40g</b></li>
          <li>दालचीनी पाउडर <b>40g</b></li>
        </ul>
        <div class="festival-pack-stage-bottom">
          <div><div class="festival-pack-stage-price">₹799</div><div class="festival-pack-stage-free">✓ Delivery FREE</div></div>
          <button type="button" class="festival-pack-stage-cart" id="festivalPackAddToCart">🛒 Add to Cart</button>
        </div>
      </div>
    </div>
  </div>
</section>
<script>
(function(){
  function initFestivalPack(){
    const btn=document.getElementById('festivalPackAddToCart');
    if(btn && typeof window.__shudhAddToCart==='function'){
      btn.addEventListener('click',function(){
        window.__shudhAddToCart('Shudh Sanjivani Festival Pack','15 Spice Combo Pack',799,'');
        btn.textContent='✓ कार्ट में जोड़ दिया';
        setTimeout(function(){btn.textContent='🛒 Add to Cart';},1200);
      });
    }
    document.querySelectorAll('a,button').forEach(function(el){
      const t=(el.textContent||'').trim();
      if(/festival|फेस्टिवल|15 spice combo|15-spice combo/i.test(t) && el.id!=='festivalPackAddToCart'){
        el.addEventListener('click',function(){
          const target=document.getElementById('festival-pack');
          if(target){setTimeout(function(){target.scrollIntoView({behavior:'smooth',block:'start'});},0);}
        },false);
      }
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initFestivalPack);
  else initFestivalPack();
})();
</script>
`);
    }})
    .on('head', { element(el) {
      el.onEndTag(end => {
        if(!hasDescription) end.before(`<meta name="description" content="${seo.description}">`, {html:true});
        if(!hasRobots) end.before('<meta name="robots" content="index, follow">', {html:true});
        if(!hasCanonical) end.before('<link rel="canonical" href="https://shudhsanjivani.in/">', {html:true});
        if(!hasOgTitle) end.before(`<meta property="og:title" content="${seo.title}">`, {html:true});
        if(!hasOgDescription) end.before(`<meta property="og:description" content="${seo.description}">`, {html:true});
        if(!hasOgUrl) end.before('<meta property="og:url" content="https://shudhsanjivani.in/">', {html:true});
        end.before('<meta property="og:type" content="website">', {html:true});
        end.before('<meta property="og:site_name" content="Shudh Sanjivani">', {html:true});
        const productNames = [
          "Amba Turmeric","Besan","Amla Powder","Whole Coriander Seeds","Whole Black Pepper","Multigrain Flour",
          "Salem Fali Turmeric Powder","Red Chilli Powder","Coriander Powder","Cumin Powder","Cardamom Powder",
          "Black Pepper Powder","White Pepper Powder","Dry Ginger Powder","Cinnamon Powder","Amchur Powder",
          "Cumin","Green Cardamom","Fennel Seeds","Carom Seeds","Cloves","Whole Spices","Garam Masala Powder",
          "Tea Masala"
        ];
        const structuredData = {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Organization",
              "@id": "https://shudhsanjivani.in/#organization",
              "name": "Shudh Sanjivani",
              "url": "https://shudhsanjivani.in/"
            },
            {
              "@type": "WebSite",
              "@id": "https://shudhsanjivani.in/#website",
              "name": "Shudh Sanjivani | Pure Spices & Natural Products",
              "url": "https://shudhsanjivani.in/",
              "publisher": { "@id": "https://shudhsanjivani.in/#organization" }
            },
            {
              "@type": "ItemList",
              "@id": "https://shudhsanjivani.in/#product-list",
              "name": "Shudh Sanjivani Product Catalogue",
              "itemListElement": productNames.map((name, index) => ({
                "@type": "ListItem",
                "position": index + 1,
                "name": name
              }))
            },
            {
              "@type": "WebPage",
              "@id": "https://shudhsanjivani.in/#webpage",
              "url": "https://shudhsanjivani.in/",
              "name": "Shudh Sanjivani | Pure Spices for Everyday Cooking",
              "description": seo.description,
              "inLanguage": "hi-IN",
              "isPartOf": { "@id": "https://shudhsanjivani.in/#website" },
              "about": { "@id": "https://shudhsanjivani.in/#organization" }
            }
          ]
        };
        end.before('<script type="application/ld+json">' + JSON.stringify(structuredData) + '</script>', {html:true});
      });
    }})
    .transform(response);
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (url.pathname === '/api/razorpay/create-order' && request.method === 'POST') return createOrder(request, env);
    if (url.pathname === '/api/razorpay/verify-payment' && request.method === 'POST') return verifyPayment(request, env);
    if (url.pathname === '/api/orders/save' && request.method === 'POST') return saveOrder(request, env);
    if (url.pathname === '/api/shipping/track' && request.method === 'GET') return trackShipment(request, env);
    if (url.pathname === '/api/reviews' && request.method === 'GET') return listReviews(request, env);
    if (url.pathname === '/api/reviews' && request.method === 'POST') return saveReview(request, env);
    if (url.pathname === '/api/admin/orders' && request.method === 'GET') return listOrders(request, env);
    // Stage 171: explicitly serve the recipe HTML file for the clean recipe route.
    if (url.pathname === '/track-order') { const u=new URL(request.url); u.pathname='/track-order.html'; return env.ASSETS.fetch(new Request(u, request)); }
    if (url.pathname === '/achari-masala-recipe') {
      const recipeUrl = new URL(request.url);
      recipeUrl.pathname = '/achari-masala-recipe.html';
      return applySeo(await env.ASSETS.fetch(new Request(recipeUrl, request)), false);
    }
    if (url.pathname === '/haldi-bharat-ki-har-rasoi-ki-shaan') {
      const blogUrl = new URL(request.url);
      blogUrl.pathname = '/haldi-bharat-ki-har-rasoi-ki-shaan.html';
      return env.ASSETS.fetch(new Request(blogUrl, request));
    }
    if (url.pathname === '/lal-mirch-ki-kahani' || url.pathname === '/lal-mirch-ki-kahani-v2') {
      const blogUrl = new URL(request.url);
      blogUrl.pathname = '/lal-mirch-ki-kahani.html';
      return env.ASSETS.fetch(new Request(blogUrl, request));
    }
    if (url.pathname === '/garam-masala-recipe') {
      const recipeUrl = new URL(request.url);
      recipeUrl.pathname = '/garam-masala-recipe.html';
      return applySeo(await env.ASSETS.fetch(new Request(recipeUrl, request)), false);
    }
    const assetResponse = await env.ASSETS.fetch(request);
    // Stage 96: prevent the production HTML from being served from an older edge/browser cache.
    // This is important while deploying the checkout/order-flow fix.
    const headers = new Headers(assetResponse.headers);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      headers.set('Pragma', 'no-cache');
      headers.set('Expires', '0');
    }
    const response = new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
    return applySeo(response, url.pathname === '/' || url.pathname === '/index.html');
  }
};