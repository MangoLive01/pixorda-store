// Vercel Serverless Function. Al-Style token stays server-side.
const BASE = 'https://api.al-style.kz';
const PAGE_SIZE = 24;
const cache = new Map();
let lastUpstreamAt = 0;
const CACHE_MS = 90 * 1000;
const MIN_GAP_MS = 5500;

function send(res, code, body, headers={}) {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers});
  res.end(JSON.stringify(body));
}
const limitText = (v, max=120) => String(v ?? '').trim().slice(0,max);

async function handler(req,res) {
  if(req.method!=='GET')return send(res,405,{error:'Метод не поддерживается'});
  const mode=limitText(req.query?.mode || 'products',24);
  if(mode==='settings') return send(res,200,{shopName:process.env.SHOP_NAME||'PIXORDA', whatsapp:(process.env.SHOP_WHATSAPP||'').replace(/\D/g,'')});
  if(mode!=='products')return send(res,400,{error:'Неизвестный режим'});
  const token=process.env.ALSTYLE_API_TOKEN;
  if(!token)return send(res,503,{error:'Каталог ещё не подключён. Добавьте ALSTYLE_API_TOKEN в настройки Vercel.'});
  const page=Math.max(1,Math.min(1000,Number.parseInt(req.query?.page,10)||1));
  const term=limitText(req.query?.q,85);
  const categoryRaw=limitText(req.query?.category,12);
  const category=/^\d+$/.test(categoryRaw)?categoryRaw:'';
  const cacheKey=JSON.stringify({page,term,category});
  const cached=cache.get(cacheKey);
  if(cached && Date.now()-cached.time<CACHE_MS) return send(res,200,{...cached.value,cached:true});
  if(Date.now()-lastUpstreamAt<MIN_GAP_MS)return send(res,429,{error:'Поставщик разрешает один запрос каждые 5 секунд. Подождите и попробуйте снова.',retryAfter:6},{'Retry-After':'6'});
  lastUpstreamAt=Date.now();

  const params=new URLSearchParams();
  params.set('access-token',token);
  let endpoint;
  if(term){
    endpoint='/api/element-info';
    params.set('name',term);
    params.set('additional_fields','images,brand,url');
  }else{
    endpoint='/api/elements-pagination';
    params.set('limit',String(PAGE_SIZE));
    params.set('offset',String((page-1)*PAGE_SIZE));
    params.set('additional_fields','images,brand,url');
    if(category)params.set('category',category);
  }
  try {
    const response=await fetch(BASE+endpoint+'?'+params.toString(),{
      method:'GET',
      headers:{'Accept':'application/json'},
      signal:AbortSignal.timeout(15000)
    });
    if(!response.ok)throw Error('Поставщик ответил с кодом '+response.status);
    const data=await response.json();
    if(data?.status===false)throw Error('Поставщик вернул ошибку');
    let raw=Array.isArray(data)?data:(data?.elements||data?.data?.elements||data?.data||[]);
    if(Array.isArray(raw[0]))raw=raw.flat();
    if(!Array.isArray(raw))raw=[];
    if(term)raw=raw.slice(0,100);
    const products=raw.map(p=>({
      id:String(p.article||''),
      name:String(p.name||p.full_name||'Без названия').slice(0,220),
      fullName:String(p.full_name||'').slice(0,400),
      articlePN:String(p.article_pn||'').slice(0,100),
      category:String(p.category||''),
      brand:typeof p.brand==='string'?p.brand:(p.brand?.name||''),
      price:typeof p.price2==='number'?p.price2:Number(p.price2)||null,
      dealerPrice: null, // never expose wholesale pricing to customers
      stock:p.quantity===undefined?null:String(p.quantity),
      image:(()=>{
        let v=p.images;
        if(Array.isArray(v))v=v[0];
        if(v && typeof v==='object')v=v.url||v.src||v.image||'';
        if(typeof v!=='string')return '';
        if(v.startsWith('//'))v='https:'+v;
        if(v.startsWith('http://img.al-style.kz/'))v=v.replace('http://','https://');
        return /^https:\/\//i.test(v)?v:'';
      })(),
      productUrl:(typeof p.url==='string' && /^https:\/\//.test(p.url))?p.url:''
    })).filter(p=>p.id);
    const pagination=data?.pagination||data?.data?.pagination||{};
    const result={products,page,pages:term?1:Math.max(1,Number(pagination.totalPages)||page),total:term?products.length:Number(pagination.totalCount)||products.length,search:term,source:'Al-Style',updatedAt:new Date().toISOString()};
    cache.set(cacheKey,{time:Date.now(),value:result});
    if(cache.size>45)cache.delete(cache.keys().next().value);
    return send(res,200,result);
  }catch(err){
    return send(res,502,{error:'Не удалось получить каталог Al-Style. '+String(err.message||'Ошибка').slice(0,150)});
  }
}
module.exports=handler;
