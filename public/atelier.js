'use strict';
(() => {
  const $=id=>document.getElementById(id), make=(tag,text,cls)=>Object.assign(document.createElement(tag),{textContent:text??'',className:cls||''});
  const icons={gallery:'M3 4h18v16H3z M3 15l5-5 5 5 3-3 5 5',projects:'M3 7h7l2 2h9v11H3z M4 4h7l2 2h7',ranking:'M4 20V12h4v8z M10 20V4h4v16z M16 20V8h4v12z',create:'M4 5h16v14H4z M9 12h6 M12 9v6'};
  document.querySelectorAll('[data-icon]').forEach(a=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const p=document.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',icons[a.dataset.icon]);svg.append(p);a.prepend(svg);});
  const modes={gallery:['我的视频','浏览本地视频版本、核验成片与制作素材。'],projects:['智能制作','从已有项目继续查看作品，或开始一次新的制作。'],ranking:['商品榜单','按本地制作证据查看商品表现，未核验的商业数据保留为空。']};
  const cats=['全部视频','核验成片','交付 / 预览','过程片段','商品素材','全部记录'];
  let rows=[],token='',category=cats[0],page=0;
  let curated=false,folder='';
  const images='商品素材',folders='故事文件夹';
  function stories(list){return [...new Set(list.filter(r=>r.story).map(r=>r.story))];}
  function enter(story){folder=story;category=folders;if(activeMode()!=='gallery')location.hash='gallery';else gallery();scrollTo(0,0);}
  const name=r=>r.title||r.location.split(/[\\/]/).pop().replace(/\.[^.]+$/,'');
  const date=r=>r.updated?r.updated.slice(0,10):'日期未知';
  const base=r=>'/library/'+r.id+'/';
  const clock=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
  function image(r){const i=make('img');i.loading='lazy';i.decoding='async';i.alt='';if(r.cover)i.src=base(r)+'cover';else i.alt='暂无封面';return i;}
  function action(label,fn,cls){const b=make('button',label,cls);b.onclick=fn;return b;}
  function link(label,url,cls){const a=make('a',label,cls);a.href=url;return a;}
  function activeMode(){return modes[location.hash.slice(1)]?location.hash.slice(1):'gallery';}
  function route(){const m=activeMode();Object.keys(modes).forEach(k=>$(k).hidden=k!==m);$('where').textContent=$('title').textContent=modes[m][0];$('intro').textContent=modes[m][1];$('start').hidden=m!=='projects';$('refresh').hidden=m==='projects';document.querySelectorAll('#rail nav a').forEach(a=>{if(a.hash==='#'+m)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});if(m==='ranking')rank();else if(m==='projects')projects();else gallery();}
  function matches(r,c){return c==='全部记录'||(c==='全部视频'?/\.mp4$/i.test(r.location):r.kind===c);}
  function choose(c){category=c;folder='';if($('mobile').open)$('mobile').close();gallery();}
  function categories(box){box.replaceChildren();for(const c of curated?[folders,images]:cats){const b=action(c,()=>choose(c),'cat'+(category===c?' active':''));b.setAttribute('aria-pressed',String(category===c));b.append(make('small',c===folders?stories(rows).length:rows.filter(r=>matches(r,c)).length));box.append(b);}}
  function details(r){
    const box=$('detail');box.replaceChildren();$('detailTitle').textContent=name(r);
    if(r.available){const video=/\.mp4$/i.test(r.location);const m=make(video?'video':'img');if(video){m.controls=true;m.preload='metadata';if(r.cover)m.poster=base(r)+'cover';}m.src=base(r)+'view';box.append(m);
      const buttons=make('div','','actions'),open=link('打开文件',base(r)+'view','button');open.target='_blank';open.rel='noopener';buttons.append(open,link('下载文件',base(r)+'download','button'));
      const call=async(b,act)=>{try{const res=await fetch(base(r)+act,{method:'POST',headers:{'X-Library-Token':token}});if(!res.ok)throw Error();b.textContent=act==='status'?(await res.json()).state:'已请求打开';}catch{b.textContent='操作未完成';}};
      buttons.append(action('所在目录',e=>call(e.currentTarget,'folder')));if(r.task)buttons.append(action('查询 Ark 状态',e=>call(e.currentTarget,'status')));box.append(buttons);
    }else box.append(make('p','文件缺失或不可读'));
    const info=make('div','','fileinfo');for(const v of [r.product+' · '+r.kind,'更新：'+date(r),'本地位置：'+r.location,'资产 ID：'+r.id,'任务：'+(r.task||'无已核对回执')])info.append(make('p',v));box.append(info);$('drawer').showModal();
  }
  function gallery(){
    categories($('cats'));$('collection').textContent=category;
    const q=$('search').value.trim().toLowerCase();
    let found=rows.filter(r=>(curated?(category===images?r.kind===images:!!r.story):matches(r,category))&&(!$('product').value||r.product===$('product').value)&&(!$('available').value||r.available===($('available').value==='yes'))&&[name(r),r.story,r.location,r.product,r.task].join(' ').toLowerCase().includes(q));
    if(curated&&category!==images){
      if(!folder){
        $('cards').replaceChildren();const names=stories(found);$('total').textContent=`${names.length} 个故事`;
        for(const story of names){const items=rows.filter(r=>r.story===story),r=items[0],card=make('article','','work'),poster=make('div','','poster'),b=action('打开故事',()=>enter(story),'open');b.setAttribute('aria-label','展开 '+story);b.replaceChildren(make('span','展开','play'));poster.append(image(r),b);card.append(poster,make('h3',story),make('p',`${items.some(x=>x.role==='full')?'字幕全长 1':'字幕全长缺失'} · 无字幕单段 ${items.filter(x=>x.role!=='full').length}`,'meta'));$('cards').append(card);}
        if(!names.length)$('cards').append(make('p','暂无匹配的精选故事。','empty'));return;
      }
      found=rows.filter(r=>r.story===folder);
      $('collection').textContent=folder;$('collection').prepend(action('‹ 返回故事',()=>enter(''),'button'));
    }
    $('total').textContent=`${found.length} 项`;$('cards').replaceChildren();
    if(curated&&folder&&found[0]?.note){const note=make('p',found[0].note,'empty');$('cards').append(note);}
    for(const r of found){const card=make('article','','work'),poster=make('div','','poster'),open=action('',()=>details(r),'open');open.setAttribute('aria-label','查看 '+name(r));open.append(make('span',/\.mp4$/i.test(r.location)?'▶':'＋','play'));poster.append(image(r),open);
      if(r.available){const dl=link('↓',base(r)+'download','download');dl.setAttribute('aria-label','下载 '+name(r));poster.append(dl);}
      if(r.duration)poster.append(make('span',clock(r.duration),'duration'));
      const meta=make('div','','meta');meta.append(make('span',r.available?r.kind:'缺失','tag'),make('time',date(r)));card.append(poster,make('h3',name(r)),meta);$('cards').append(card);}
    if(!found.length)$('cards').append(make('p','没有匹配作品，请调整分类或筛选。','empty'));
  }
  function projects(){const target=$('projectCards');target.replaceChildren();const groups=new Map();
    if(curated){for(const story of stories(rows)){const members=rows.filter(r=>r.story===story),b=action('',()=>{for(const id of ['search','available','product'])$(id).value='';enter(story);},'pc');b.append(image(members[0]),make('strong',story),make('small',`${members.length} 项精选作品`));target.append(b);}return;}
    for(const r of rows.filter(r=>r.kind!=='商品素材')){const k=r.group; if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
    for(const items of [...groups.values()].sort((a,b)=>String(b[0].updated).localeCompare(String(a[0].updated))).slice(0,4)){
      const r=items[0],b=action('',()=>details(r),'pc'),text=make('div');text.append(make('strong',name(r)),make('small',`${items.length} 个同目录版本 · ${r.kind}`),make('small',`${date(r)}　查看作品 ›`));b.append(image(r),text);target.append(b);}
    if(!groups.size)target.append(make('p','暂无项目。'));
  }
  function rank(){
    const g=new Map();for(const r of rows){if(!g.has(r.product))g.set(r.product,{name:r.product,final:0,assets:0,time:0,tasks:new Set()});const x=g.get(r.product);if(!r.available)continue;if(r.kind==='商品素材'){x.assets++;x.img??=r;}if(r.kind==='核验成片')x.final++;if(r.task)x.tasks.add(r.task);x.time=Math.max(x.time,Date.parse(r.updated)||0);}
    const key=$('order').value,v=x=>key==='tasks'?x.tasks.size:x[key],all=[...g.values()].filter(x=>x.name.toLowerCase().includes($('rankQuery').value.trim().toLowerCase())).sort((a,b)=>v(b)-v(a)||a.name.localeCompare(b.name,'zh-CN'));
    const pages=Math.max(1,Math.ceil(all.length/10));page=Math.min(page,pages-1);$('rankRows').replaceChildren();
    for(const [i,x] of all.slice(page*10,page*10+10).entries()){const tr=$('rankRows').insertRow();tr.insertCell().textContent=page*10+i+1;const td=tr.insertCell();if(x.img&&!curated){const img=image(x.img);img.className='rankImg';td.append(img);}td.append(action(x.name,()=>{category=curated?folders:'全部记录';folder='';$('product').value=x.name;$('available').value='';$('search').value='';location.hash='gallery';}));for(const field of [x.final,x.assets,x.tasks.size,x.time?new Date(x.time).toISOString().slice(0,10):'—','—','—','—','—','—'])tr.insertCell().textContent=field;}
    $('page').textContent=`${page+1} / ${pages} · ${all.length} 个商品`;$('prev').disabled=!page;$('next').disabled=page+1>=pages;
  }
  async function refresh(){try{const res=await fetch('/library/catalog');if(!res.ok)throw Error();const data=await res.json();token=data.token;rows=data.rows.sort((a,b)=>(a.displayOrder??999)-(b.displayOrder??999)||String(b.updated).localeCompare(String(a.updated)));
    curated=data.curated===true;if(curated){if(category!==images)category=folders;modes.gallery=['精选故事','打开故事，先看当前字幕全长，再按顺序查看无字幕单段。'];}
    const sel=$('product'),prev=sel.value;sel.replaceChildren(new Option('全部商品',''));for(const p of new Set(rows.map(r=>r.product)))sel.add(new Option(p,p));sel.value=prev;$('notice').textContent=data.selectionUnavailable?'精选清单不可用，未展示未选作品。':'';route();}catch{rows=[];route();$('notice').textContent='无法读取本地索引，请刷新重试。';}}
  $('prev').onclick=()=>{page--;rank();};$('next').onclick=()=>{page++;rank();};for(const id of ['rankQuery','order'])$(id).oninput=()=>{page=0;rank();};
  for(const id of ['search','product','available'])$(id).oninput=()=>{if(curated)folder='';gallery();};
  $('refresh').onclick=refresh;
  for(const d of document.querySelectorAll('dialog'))d.querySelector('.close').onclick=()=>d.close();
  $('drawer').onclose=()=>$('detail').replaceChildren();
  $('catMenu').onclick=()=>{$('mobileTitle').textContent='作品分类';categories($('choices'));$('mobile').showModal();};
  $('menu').onclick=()=>{$('mobileTitle').textContent='工作台导航';$('choices').replaceChildren();for(const a of document.querySelectorAll('#rail nav a')){const b=link(a.textContent,a.href,'button');b.onclick=()=>$('mobile').close();$('choices').append(b);}$('mobile').showModal();};
  window.onhashchange=()=>{route();scrollTo(0,0);};route();refresh();
})();
