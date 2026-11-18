'use strict';
(async () => {
  if (window.top !== window.self) throw Error();
  const el = id => document.getElementById(id);
  const response = await fetch('/library/catalog');
  if (!response.ok) throw Error();
  const {rows,token,ark} = await response.json();
  rows.sort((a,b) => (b.updated||'').localeCompare(a.updated||''));
  el('summary').textContent = ark ? `Ark 视频密钥${ark.configured?'已配置':'未配置'}（服务端读取于 ${ark.configAt}，非连通验证）。协议模型：${ark.protocolModels.join('、')}；不提交生成任务。` : '旧版服务 · 视频配置未知';
  for (const key of ['product','kind']) for (const v of ['',...new Set(rows.map(r=>r[key]))]) el(key).add(new Option(v||'全部',v));
  function detail(r) {
    const box=el('detail'); box.replaceChildren();
    for (const s of [r.product+' / '+r.kind,r.group,'生成任务：'+(r.task||'无已核对回执'),r.location,r.available?`${r.bytes.toLocaleString()} 字节 · ${new Date(r.updated).toLocaleString()}`:'文件缺失、不可读或不符合白名单']) {
      const p=document.createElement('p'); p.textContent=s; box.append(p);
    }
    if (!r.available) return;
    const base='/library/'+r.id+'/';
    if (ark?.configured && r.task) {
      const status=document.createElement('button');status.textContent='读取 Ark 状态（仅查询）';box.append(status);
      status.onclick=async()=>{status.disabled=true;try {
        const res=await fetch(base+'status',{method:'POST',headers:{'X-Library-Token':token}});
        if(!res.ok) throw Error();
        const data=await res.json();status.textContent=`${data.source} · ${data.state} · 模型 ${data.model||'未核验'} · ${data.checkedAt}`;
      }catch{status.textContent='查询不可用，未取得任务状态';}finally{status.disabled=false;}};
    }
    const media=document.createElement(/\.mp4$/i.test(r.location)?'video':'img');
    if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';} media.src=base+'view'; box.append(media);
    for(const [label,action] of [['打开文件','view'],['下载','download']]){
      const a=document.createElement('a'); a.textContent=label;a.href=base+action;
      if(action==='view'){a.target='_blank';a.rel='noopener';}else a.download='';box.append(a);
    }
    const b=document.createElement('button'); b.textContent='打开所在目录';box.append(b);
    b.onclick=async()=>{try{const result=await fetch(base+'folder',{method:'POST',headers:{'X-Library-Token':token}});b.textContent=result.ok?'已请求打开':'打开失败';}catch{b.textContent='打开失败';}};
  }
  function render(){
    const q=el('query').value.trim().toLowerCase();
    const found=rows.filter(r=>(!el('product').value||r.product===el('product').value)&&(!el('kind').value||r.kind===el('kind').value)&&(!el('available').value||(r.available?'yes':'no')===el('available').value)&&[r.location,r.task,r.group,r.product].join(' ').toLowerCase().includes(q));
    const list=el('list');list.replaceChildren(); el('count').textContent=`${found.length} / ${rows.length} 条记录 · 最近更新优先`;el('detail').textContent=found.length?'选择记录查看详情。':'没有匹配记录。';
    for(const r of found){const b=document.createElement('button');b.textContent=`${r.available?'可用':'缺失 / 不可读'} · ${r.kind} · ${r.location.split(/[\\/]/).pop()} — ${r.group}`;b.onclick=()=>{list.querySelector('[aria-pressed=true]')?.setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');detail(r);};list.append(b);}
  }
  for(const id of ['query','kind','product','available'])el(id).addEventListener('input',render);
  const groups=new Map();
  for(const r of rows){
    if(!groups.has(r.product))groups.set(r.product,{name:r.product,final:0,assets:0,ids:new Set(),time:0});
    const g=groups.get(r.product);
    if(!r.available)continue;
    if(r.kind==='核验成片')g.final++;
    if(r.kind==='商品素材')g.assets++;
    if(r.task)g.ids.add(r.task);
    g.time=Math.max(g.time,Date.parse(r.updated)||0);
  }
  let page=0;
  function view(rank){
    el('ranking').hidden=!rank;
    document.querySelector('main>section').hidden=rank;document.querySelector('.layout').hidden=rank;
    if(rank)rankTable();else render();
  }
  function rankTable(){
    const key=el('sort').value, q=el('rankQuery').value.trim().toLowerCase();
    const value=g=>key==='tasks'?g.ids.size:g[key];
    const sorted=[...groups.values()].filter(g=>g.name.toLowerCase().includes(q)).sort((a,b)=>value(b)-value(a)||a.name.localeCompare(b.name,'zh-CN')||(a.name<b.name?-1:a.name>b.name?1:0));
    const pages=Math.max(1,Math.ceil(sorted.length/10));page=Math.min(page,pages-1);
    el('rankRows').replaceChildren();
    for(const [i,g] of sorted.slice(page*10,page*10+10).entries()){
      const tr=el('rankRows').insertRow();tr.insertCell().textContent=String(page*10+i+1);
      const button=document.createElement('button');button.textContent=g.name;tr.insertCell().append(button);
      button.onclick=()=>{el('product').value=g.name;for(const id of ['query','kind','available'])el(id).value='';view(false);};
      for(const v of [g.final,g.assets,g.ids.size,g.time?new Date(g.time).toLocaleString():'—','—','—','—','—','—'])tr.insertCell().textContent=v;
    }
    el('page').textContent=`${page+1} / ${pages} · ${sorted.length} 个商品`;el('prev').disabled=!page;el('next').disabled=page+1===pages;
  }
  el('showRanking').onclick=()=>view(true);el('showLibrary').onclick=()=>view(false);
  for(const id of ['rankQuery','sort'])el(id).oninput=()=>{page=0;rankTable();};
  el('next').onclick=()=>{page++;rankTable();};el('prev').onclick=()=>{page--;rankTable();};
  render();
})().catch(()=>{document.getElementById('summary').textContent='无法加载本地索引。';});
