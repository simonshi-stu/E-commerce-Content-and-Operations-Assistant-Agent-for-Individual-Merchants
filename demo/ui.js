(() => {
  'use strict';
  const core = globalThis.DemoCore, $ = id => document.getElementById(id);
  const storageKey = 'pianshi-merchant-demo-v1';
  const localLimit=48*1024*1024, recordLimit=60;
  let dbPromise;
  const fields = {sku:'shot-sku',assetId:'shot-reference',character:'shot-character',action:'shot-action',duration:'shot-duration',aspect:'shot-aspect',avoidAdWords:'shot-avoid'};
  const sourceNames = {default:'系统默认',global:'全局',project:'项目',sku:'SKU',explicit:'本次',previous:'上一段',previousMissing:'缺少参考'};
  const mimeKinds = {'image/jpeg':'image','image/png':'image','image/webp':'image','video/mp4':'video','video/webm':'video'};
  const sampleSku = 'DEMO-001', character = '示例人物 01（合成人物）';
  const samples = [
    {path:'./sample-product.svg',name:'示例商品 · 粉色眼镜',kind:'image'},
    {path:'./sample-motion.mp4',name:'示例视频 · 合成图形',kind:'video'}
  ];
  const example = '看价签拿梨，6 秒，跟上一段同一个人。';
  let state = load(), assets = [], source = state.sources || {}, restoredSample = false, generation = 0;

  function load() {
    try { const data = JSON.parse(localStorage.getItem(storageKey)); return data?.version === 1 ? data : {version:1}; }
    catch { return {version:1}; }
  }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); }
    catch { $('archive-note').textContent = '此浏览器不能保存本地状态；本页流程仍然可以使用。'; }
  }
  function sku() { return $('sku').value.trim().toUpperCase(); }
  function skuOk(value) { return /^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(value); }
  function status(id,message) { $(id).textContent = message; }
  function revokeAssets() { assets.forEach(a => { if (a.objectUrl) URL.revokeObjectURL(a.url); }); assets = []; }
  function currentAssets() { return assets.filter(a => a.sku === sku()); }
  function openAssets() {
    if (!dbPromise) dbPromise=new Promise((resolve,reject)=>{
      try {
        const req=indexedDB.open(storageKey+'-assets',1);
        req.onupgradeneeded=()=>req.result.createObjectStore('materials',{keyPath:['sku','id']});
        req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); req.onblocked=()=>reject(Error("asset_store_blocked"));
      } catch (e) { reject(e); }
    });
    return dbPromise;
  }
  async function localAssets(mode, work) {
    const db=await openAssets();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('materials',mode);
      let value;
      tx.oncomplete=()=>resolve(value); tx.onabort=()=>reject(tx.error);
      work(tx.objectStore('materials'),v=>{value=v;});
    });
  }
  async function saveAsset(record) {
    return localAssets('readwrite',(store,done)=>{
      const existing=store.getAll();
      existing.onsuccess=()=>{
        const entries=existing.result;
        if(entries.some(a=>a.sku===record.sku&&a.id===record.id)){done('duplicate');return;}
        if(entries.length>=recordLimit || entries.reduce((n,a)=>n+a.blob.size,0)+record.blob.size>localLimit){done('full');return;}
        store.put(record);done('saved');
      };
    });
  }
  function labelFromName(name) {
    const tests=[['正面',/正面|(?:^|[ _.-])front(?:[ _.-]|$)/i],['侧面',/侧面|(?:^|[ _.-])side(?:[ _.-]|$)/i],['人物',/人物|人像|佩戴|(?:^|[ _.-])(?:portrait|person|model)(?:[ _.-]|$)/i],['细节',/细节|特写|(?:^|[ _.-])(?:detail|closeup)(?:[ _.-]|$)/i]];
    const match=tests.find(([,re])=>re.test(name));return match?match[0]+'（按文件名）':'通用素材';
  }
  async function restoreAssets() {
    const seq=generation;
    try {
      const records=await localAssets('readonly',(store,done)=>{const req=store.getAll();req.onsuccess=()=>done(req.result);});
      if(seq!==generation)return;
      records.forEach(a=>add({...a,url:URL.createObjectURL(a.blob),objectUrl:true}));
      renderAssets($('shot-reference').value||state.shot?.assetId);
      if(records.length)status('import-note','已恢复当前浏览器保存的素材，按 SKU 切换查看。');
    } catch { if(seq===generation)status('import-note','此浏览器无法读取本地素材库。本页仍可预览新导入的文件。'); }
  }
  async function digest(blob) {
    if (!globalThis.crypto?.subtle) throw Error('local_hash_unavailable');
    const b = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2,'0')).join('');
  }
  function add(asset) {
    if (assets.some(a => a.id === asset.id && a.sku === asset.sku)) {
      if (asset.objectUrl) URL.revokeObjectURL(asset.url);
      return false;
    }
    assets.push(asset); return true;
  }
  function renderAssets(preferred = $('shot-reference').value) {
    const list = currentAssets(), gallery = $('assets'), options = $('shot-reference');
    gallery.replaceChildren(); options.replaceChildren(new Option('请选择素材',''));
    if (!list.length) {
      const empty=document.createElement('p'); empty.className='empty';
      empty.textContent = '当前 SKU 还没有素材。添加本地文件，或一键加载演示素材。'; gallery.append(empty);
    }
    list.forEach((a) => {
      const card=document.createElement('article'), m=document.createElement(a.kind==='image'?'img':'video'), name=document.createElement('p');
      card.className='asset'; m.src=a.url;
      if(a.kind==='image'){m.alt=a.name;m.loading='lazy';}else{m.controls=true;m.playsInline=true;m.preload='metadata';m.setAttribute('aria-label',a.name);}
      name.textContent=(a.kind==='image'?'图片 · ':'视频 · ')+a.name; const label=document.createElement('small');label.textContent=a.label||'合成样例';card.append(m,name,label);gallery.append(card);
      options.add(new Option(name.textContent,a.id));
    });
    if (list.some(a=>a.id===preferred)) options.value=preferred;
    $('shot-sku').value=sku();
  }

  async function useSample(fillInstruction = true) {
    const seq = generation;
    $('use-sample').disabled = true;
    status('import-note','正在读取同源示例素材…');
    try {
      const records=await Promise.all(samples.map(async a => {
        const response=await fetch(a.path,{mode:'same-origin'});
        if(!response.ok) throw Error('sample_missing');
        return {...a,url:a.path,sku:sampleSku,id:'a-'+await digest(await response.blob())};
      }));
      if (seq !== generation) return;
      let n=0; records.forEach(a=>{if(add(a)) n++;});
      state.sample=true; state.reference=true; restoredSample=true;
      if(fillInstruction) {
        $('sku').value=sampleSku;
        if(!$('instruction').value.trim()) $('instruction').value='将粉色眼镜抬至镜头前，6 秒，跟上一段同一个人。';
      }
      state.sku=sku();renderAssets(state.shot?.assetId || records[0].id);renderCharacter();
      persist(); status('import-note',n?'已加载 1 张商品图、1 部示例视频与上一段合成角色。':'示例素材已经存在，没有重复导入。');
    } catch { if (seq===generation) status('import-note','未能读取示例素材。请使用演示启动地址重新打开；也可以手动导入本地文件。'); }
    finally { $('use-sample').disabled=false; }
  }
  async function importFiles(files) {
    const target=sku(), seq=generation;
    if(!skuOk(target)){status('import-note','先填写商品 SKU，仅用字母、数字、下划线或短横线。');return;}
    if(!files.length)return;
    let inserted=0,duplicate=0,invalid=0,temporary=0,full=0;
    for(const f of files.slice(0,12)) {
      const kind=mimeKinds[f.type];
      if(!kind || !f.size || f.size>25*1024*1024) {invalid++;continue;}
      try {
        const id='a-'+await digest(f);
        if(seq!==generation)return;
        if(assets.some(a=>a.id===id&&a.sku===target)){duplicate++;continue;}
        const imported=assets.filter(a=>a.blob);
        if(imported.length>=recordLimit || imported.reduce((n,a)=>n+a.blob.size,0)+f.size>localLimit){full++;continue;}
        const record={id,kind,sku:target,name:f.name,label:labelFromName(f.name),blob:f};
        try {
          const result=await saveAsset(record);
          if(seq!==generation)return;
          if(result==='duplicate'){duplicate++;continue;}
          if(result==='full'){full++;continue;}
        } catch { if(seq!==generation)return;temporary++; }
        if(add({...record,url:URL.createObjectURL(f),objectUrl:true}))inserted++;
      } catch { invalid++; }
    }
    invalid+=Math.max(0,files.length-12);
    renderAssets($('shot-reference').value||currentAssets()[0]?.id);
    status('import-note','SKU '+target+'：导入 '+inserted+'，重复 '+duplicate+'，跳过 '+invalid+'。'+(temporary?' 有 '+temporary+' 份未能保存，只能在此页临时预览。':'')+(full?' 有 '+full+' 份因素材库达到容量上限未导入。':''));
  }
  function previousCharacter() {
    if (state.job?.shot?.sku===sku()) return state.job.shot.character;
    return state.reference&&sku()===sampleSku ? character : undefined;
  }
  function renderCharacter() {
    const previous=previousCharacter();
    $('previous-reference').hidden=previous!==character;
    $('reference-note').textContent=previous?'上一段参考：'+previous+'。':'当前 SKU 没有上一段参考。可加载合成样例，或手动填写角色标记。';
  }
  function draft() {
    const parsed=core.parseInstruction($('instruction').value);
    if (skuOk(parsed.sku?.toUpperCase())) { $('sku').value=parsed.sku.toUpperCase();renderAssets(); }
    const list=currentAssets();
    const explicit={...parsed,sku:sku(),assetId:parsed.assetId || $('shot-reference').value || list[0]?.id || ''};
    const prefs=state.preferences||{};
    const result=core.resolveShot({global:prefs.global,project:prefs.project,sku:(prefs.skus||[]).find(x=>x.key===sku())?.value,explicit,previousCharacter:previousCharacter()});
    source=result.sources;
    fill(result.shot);
    readAndPersist();
    renderCharacter();
    const contextError = source.character==='previousMissing' ? '没有上一段人物参考；请加载样例或填写角色。' : '';
    showErrors(contextError);
  }
  function fill(shot) {
    for(const [key,id] of Object.entries(fields)) {
      if(key==='avoidAdWords') $(id).checked=shot[key]??core.DEFAULTS.avoidAdWords;
      else $(id).value=shot[key]??'';
    }
    $('shot-sku').value=sku();
    badges();
  }
  function badges() {
    document.querySelectorAll('[data-source]').forEach(el=>{el.textContent=sourceNames[source[el.dataset.source]]||'';});
  }
  function readShot() {
    return {sku:sku(),assetId:$('shot-reference').value,character:$('shot-character').value.trim(),action:$('shot-action').value.trim(),
      duration:$('shot-duration').valueAsNumber,aspect:$('shot-aspect').value,avoidAdWords:$('shot-avoid').checked};
  }
  function readAndPersist() {
    state.sku=sku();state.shot=readShot();state.sources=source;persist();
  }
  function showErrors(contextError='') {
    const shot=readShot(), errors={...core.validateShot(shot).errors};
    if(!errors.assetId&&!currentAssets().some(a=>a.id===shot.assetId)) errors.assetId='素材不在当前 SKU；请重新导入或换一项。';
    Object.entries(fields).forEach(([key,id])=>$(id).setAttribute('aria-invalid',String(Boolean(errors[key]))));
    status('shot-errors',[contextError,...Object.values(errors)].filter(Boolean).join(' '));
    return !contextError&&!Object.keys(errors).length;
  }
  function savePreferences() {
    const {duration,aspect,avoidAdWords}=readShot(), value={duration,aspect,avoidAdWords};
    if(!Number.isInteger(duration)||duration<4||duration>15||!core.ASPECTS.includes(aspect)) {
      status('preference-note','请输入有效时长和画面比例后再保存。');return;
    }
    const scope=$('preference-scope').value;
    state.preferences ||= {};
    if(scope==='sku'){
      if(!skuOk(sku())) { status('preference-note','请先填写有效的 SKU。');return; }
      state.preferences.skus=(state.preferences.skus||[]).filter(entry=>entry.key!==sku());
      state.preferences.skus.push({key:sku(),value});
    } else {state.preferences[scope]=value;}
    persist();
    status('preference-note','已保存到'+sourceNames[scope]+'。重新整理镜头时会按优先级生效。');
  }
  function renderJob() {
    const active=state.job?core.getJobState(state.job):null, el=$('job-status'), value=active?.status||'empty';
    el.dataset.state=value;
    const label={queued:'排队中',running:'模拟处理中',succeeded:'模拟完成',empty:'暂无模拟任务'}[value];
    if(el.textContent!==label)el.textContent=label;
    $('job-progress').hidden=!active;$('job-result').hidden=value!=='succeeded';$('submit-mock').disabled=Boolean(active&&value!=='succeeded');
    if(active){
      $('progress').value=active.progress;
      $('job-summary').textContent=active.shot.duration+' 秒 · '+active.shot.aspect+' · '+(active.shot.avoidAdWords?'不加广告词':'允许广告词')+' · 费用 0 元';
    }
  }
  function submit(event) {
    event.preventDefault();
    if(state.job&&core.getJobState(state.job).status!=='succeeded')return;
    if(!showErrors())return;
    try {
      state.job=core.createJob(readShot()); readAndPersist();renderJob();renderCharacter();
      $('jobs').scrollIntoView({block:'start'});
    } catch { status('shot-errors','镜头卡未能提交。请检查必填项。'); }
  }
  function archive() {
    try {
      const receipt=core.archiveJob(state.job), url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)+'\n'],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download='merchant-mock-archive.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      status('archive-note','已准备下载模拟归档。源文件和指令未写入归档。');
    } catch {status('archive-note','模拟任务尚未完成，不能归档。');}
  }
  async function clearRecord() {
    generation++; revokeAssets();state={version:1};source={};restoredSample=false;
    try{localStorage.removeItem(storageKey);}catch{}
    $('sku').value='';$('instruction').value='';renderAssets();fill(core.DEFAULTS);renderCharacter();renderJob();
    $('mock-video').pause();status('shot-errors','');status('preference-note','');status('import-note','');
    try { await localAssets('readwrite',store=>store.clear());
      status('archive-note','已清除此浏览器的演示记录及保存的素材副本。原始文件没有改动。');
    } catch {status('archive-note','页面记录已清除，但无法确认本地素材副本已清除。原始文件没有改动。');}
  }
  for(const aspect of core.ASPECTS)$('shot-aspect').add(new Option(aspect,aspect));
  $('sku').value=state.sku||'';renderAssets();fill(state.shot||core.DEFAULTS);renderCharacter();renderJob();
  restoreAssets();
  if(state.sample&&!restoredSample)useSample(false);
  $('use-sample').addEventListener('click',()=>useSample());
  $('example-instruction').addEventListener('click',()=>{$('instruction').value=example;$('instruction').focus();});
  $('file-picker').addEventListener('change',event=>{const files=Array.from(event.currentTarget.files||[]);event.currentTarget.value='';importFiles(files);});
  const drop=$('drop-target');
  for(const type of ['dragover','dragleave'])drop.addEventListener(type,event=>{event.preventDefault();drop.classList.toggle('over',type==='dragover');});
  drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('over');importFiles(Array.from(event.dataTransfer.files));});
  $('sku').addEventListener('change',()=>{renderAssets();readAndPersist();renderCharacter();});
  $('draft-shot').addEventListener('click',draft);
  $('save-preferences').addEventListener('click',savePreferences);
  $('shot-form').addEventListener('submit',submit);
  $('clear-local').addEventListener('click',clearRecord);
  $('download-archive').addEventListener('click',archive);
  for(const [key,id] of Object.entries(fields)) {
    if(key==='sku')continue;
    $(id).addEventListener('input',()=>{source[key]='explicit';badges();readAndPersist();});
  }
  setInterval(()=>{if(state.job)renderJob();},250);
})();
