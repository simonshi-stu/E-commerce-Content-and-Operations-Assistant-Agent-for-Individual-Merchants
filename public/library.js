'use strict';
(async () => {
  if (window.top !== window.self) throw Error();
  const el = id => document.getElementById(id);
  const response = await fetch('/library/catalog');
  if (!response.ok) throw Error();
  const {rows,token,configured} = await response.json();
  rows.sort((a,b) => (b.updated||'').localeCompare(a.updated||''));
  el('summary').textContent = `只读本地索引 · 文本服务凭据${configured?'已配置':'未配置'}（未调用） · 不提交生成任务`;
  for (const key of ['product','kind']) for (const v of ['',...new Set(rows.map(r=>r[key]))]) el(key).add(new Option(v||'全部',v));
  function detail(r) {
    const box=el('detail'); box.replaceChildren();
    for (const s of [r.product+' / '+r.kind,r.group,'生成任务：'+(r.task||'无已核对回执'),r.location,r.available?`${r.bytes.toLocaleString()} 字节 · ${new Date(r.updated).toLocaleString()}`:'文件缺失、不可读或不符合白名单']) {
      const p=document.createElement('p'); p.textContent=s; box.append(p);
    }
    if (!r.available) return;
    const base='/library/'+r.id+'/';
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
  render();
})().catch(()=>{document.getElementById('summary').textContent='无法加载本地索引。';});
