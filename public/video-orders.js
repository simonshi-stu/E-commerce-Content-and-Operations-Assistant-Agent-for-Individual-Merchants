'use strict';
(async()=>{
  if(top!==self)return;
  const $=id=>document.getElementById(id),money=n=>'¥'+(n/100).toFixed(2);
  let csrf,quote,revision=0,busy=false,configured=false;
  async function send(route,value){
    const r=await fetch('/studio/'+route,{method:'POST',headers:{'Content-Type':'application/json','x-studio-csrf':csrf},body:JSON.stringify(value)});
    const j=await r.json();if(!r.ok)throw Error(j.error);return j;
  }
  function reset(){revision++;quote=null;$('consent').checked=false;$('pay').disabled=true;$('offer').hidden=true;}
  function invalidate(){const had=!!quote;reset();if(had)send('cancel',{}).catch(()=>{});}
  function records(rows){
    const h=$('history');h.replaceChildren();if(!rows.length)h.textContent='暂无订单';
    for(const row of rows){
      const box=document.createElement('article'),p=document.createElement('p');
      p.textContent=`${new Date(row.created).toLocaleString()} · 本地单号 ${row.id} · ${row.state} · ${row.task||'未取得任务编号'} · 报价 ${money(row.estimate)} · ${row.tokens==null?'usage 未知':`${row.tokens} tokens / 用量折算 ¥${(row.tokens*46/1e6).toFixed(4)}（非账单）`}`;
      box.append(p);h.append(box);
      function button(text,fn){const b=document.createElement('button');b.textContent=text;b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){$('message').textContent=e.message;}finally{b.disabled=false;}};box.append(b);}
      if(row.task)button('查询状态',async()=>records((await send('status',{id:row.id})).orders));
      if(row.state==='succeeded'&&!row.media)button('取回并保存 MP4',async()=>records((await send('save',{id:row.id})).orders));
      if(row.media)button('预览成片',()=>{const v=$('player');v.hidden=false;v.src='/studio/media/'+row.id;});
    }
  }
  const home=await (await fetch('/studio/home')).json();csrf=home.csrf;configured=home.configured;records(home.orders);
  $('mode').textContent=`${home.mock?'模拟供应商 / 不计费':'真实 Ark / 确认后才可能计费'} · ${home.model} · 密钥${configured?'已配置':'未配置'}`;
  if(home.history){const h=home.history;$('mode').textContent+=`。本地历史成功样本（非本单规格）：${h.resolution} / ${h.seconds} 秒，API usage ${h.tokens} tokens；按上述单价折算 ¥${(h.tokens*46/1e6).toFixed(4)}，不是账单。`;}
  for(const id of ['prompt','seconds'])$(id).oninput=invalidate;
  $('estimate').onclick=async()=>{
    if(busy)return;reset();const seq=revision;
    try{const q=await send('quote',{prompt:$('prompt').value,duration:$('seconds').valueAsNumber});if(seq!==revision)return;
      quote=q;$('spec').textContent=JSON.stringify(q.body,null,2);
      $('price').textContent=`本单 ${money(q.estimate)}（预估 ${q.tokens} tokens）；含本单账本累计报价 ${money(q.prior+q.estimate)}，非累计实扣。有效至 ${new Date(q.until).toLocaleTimeString()}`;
      $('offer').hidden=false;$('message').textContent='';
    }catch(e){$('message').textContent=e.message;}
  };
  $('cancel').onclick=invalidate;
  $('consent').onchange=()=>{$('pay').disabled=!configured||!quote||!$('consent').checked;};
  $('pay').onclick=async()=>{
    if(busy||!quote||!$('consent').checked)return;busy=true;const id=quote.id;reset();
    try{records((await send('confirm',{quote:id,consent:true})).orders);$('message').textContent='请核对订单状态；不会自动重试。';}
    catch(e){$('message').textContent=`${e.message}；刷新查看账本，不要重复提交。`;}finally{busy=false;}
  };
})().catch(()=>document.getElementById('message').textContent='工作台加载失败');
