/* ============================================================================
   وحدة "الحفظ التلقائي على الجهاز" — المكتب الإداري للشيخ سعد آل عوضه
   تعتمد File System Access API لحفظ نسخة دائمة من بيانات ومرفقات التطبيقات
   في مجلد يختاره المستخدم على جهازه، مع مفتاح تشغيل/إيقاف للحفظ التلقائي.
   وحدة مستقلة تُحقن كما هي في كل تطبيق (localStorage مشترك بين كل التطبيقات).
   ============================================================================ */
(function(){
  if (window.__SAAD_LS__) return;            // منع الحقن المزدوج
  window.__SAAD_LS__ = true;

  var SUPPORTED = (typeof window.showDirectoryPicker === 'function');
  var IDB_DB = 'saad_localsave', IDB_STORE = 'kv';
  var LS_AUTO = '_saadLS_auto';              // مفتاح تشغيل الحفظ التلقائي (مشترك)
  var LS_LAST = '_saadLS_last';              // آخر حفظ (نص)
  var DEBOUNCE_MS = 4000;
  var MAX_SNAPSHOTS = 24;                    // عدد اللقطات المؤرخة المحفوظة (بالساعة)

  // معرّف التطبيق الحالي من عنوان الصفحة (لتسمية مجلدات المرفقات)
  var APP_ID = (location.pathname.split('/').pop() || 'app').replace(/\.html?$/i,'') || 'app';

  /* ---------- IndexedDB مصغّر لتخزين مقبض المجلد ومجموعة التجزئات ---------- */
  function idb(){
    return new Promise(function(res,rej){
      var r = indexedDB.open(IDB_DB, 1);
      r.onupgradeneeded = function(){ r.result.createObjectStore(IDB_STORE); };
      r.onsuccess = function(){ res(r.result); };
      r.onerror = function(){ rej(r.error); };
    });
  }
  function idbGet(k){
    return idb().then(function(db){ return new Promise(function(res,rej){
      var t = db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).get(k);
      t.onsuccess=function(){res(t.result);}; t.onerror=function(){rej(t.error);};
    });});
  }
  function idbSet(k,v){
    return idb().then(function(db){ return new Promise(function(res,rej){
      var t = db.transaction(IDB_STORE,'readwrite').objectStore(IDB_STORE).put(v,k);
      t.onsuccess=function(){res(true);}; t.onerror=function(){rej(t.error);};
    });});
  }

  /* ---------------------------- الحالة ---------------------------- */
  var state = { dir:null, auto:(localStorage.getItem(LS_AUTO)==='1'), hashes:{}, busy:false, timer:null };

  /* ---------------------------- الصلاحيات ---------------------------- */
  function perm(handle, interactive){
    if(!handle) return Promise.resolve('denied');
    var opts = {mode:'readwrite'};
    return handle.queryPermission(opts).then(function(p){
      if(p==='granted') return 'granted';
      if(!interactive) return p;
      return handle.requestPermission(opts);
    });
  }

  /* ---------------------------- أدوات ملفات ---------------------------- */
  function subDir(root, name){ return root.getDirectoryHandle(name,{create:true}); }
  function writeFile(dir, name, data){
    return dir.getFileHandle(name,{create:true}).then(function(fh){
      return fh.createWritable().then(function(w){
        return Promise.resolve(w.write(data)).then(function(){ return w.close(); });
      });
    });
  }
  function readFile(dir, name){
    return dir.getFileHandle(name,{create:false}).then(function(fh){
      return fh.getFile();
    }).then(function(f){ return f.text(); });
  }

  /* ---------------------------- جمع اللقطة ---------------------------- */
  function collectLocalStorage(){
    var o={}; for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); o[k]=localStorage.getItem(k); }
    return o;
  }
  function collectIndexedDB(){
    if(!indexedDB.databases) return Promise.resolve({});
    return indexedDB.databases().then(function(list){
      var out={}, chain=Promise.resolve();
      (list||[]).forEach(function(info){
        var name=info.name; if(!name || name===IDB_DB) return;   // لا نصدّر قاعدة الوحدة نفسها
        chain = chain.then(function(){
          return new Promise(function(res){
            var rq=indexedDB.open(name);
            rq.onsuccess=function(){
              var db=rq.result; var stores=Array.prototype.slice.call(db.objectStoreNames);
              if(!stores.length){ db.close(); out[name]={}; return res(); }
              var dump={}, done=0;
              try{
                var tx=db.transaction(stores,'readonly');
                stores.forEach(function(sn){
                  var g=tx.objectStore(sn).getAll();
                  g.onsuccess=function(){ dump[sn]=g.result; if(++done===stores.length){ db.close(); out[name]=dump; res(); } };
                  g.onerror=function(){ if(++done===stores.length){ db.close(); out[name]=dump; res(); } };
                });
              }catch(e){ db.close(); out[name]={}; res(); }
            };
            rq.onerror=function(){ res(); };
          });
        });
      });
      return chain.then(function(){ return out; });
    }).catch(function(){ return {}; });
  }
  function collectFirebase(){
    try{
      if(!window.firebase || !firebase.apps || !firebase.apps.length || !firebase.firestore) return Promise.resolve({});
      var fs=firebase.firestore(); var out={};
      var jobs=[
        fs.collection('rentals_db').doc('main').get().then(function(d){ if(d.exists) out['rentals_db/main']=d.data(); }).catch(function(){}),
        fs.collection('saad_apps').doc('payroll_data').get().then(function(d){ if(d.exists) out['saad_apps/payroll_data']=d.data(); }).catch(function(){})
      ];
      var guard=new Promise(function(r){ setTimeout(r,6000); });
      return Promise.race([Promise.all(jobs), guard]).then(function(){ return out; });
    }catch(e){ return Promise.resolve({}); }
  }
  function buildSnapshot(){
    return Promise.all([collectIndexedDB(), collectFirebase()]).then(function(r){
      return { type:'saad-office-backup', version:2, createdAt:new Date().toISOString(),
               app:APP_ID, localStorage:collectLocalStorage(), indexedDB:r[0], firebase:r[1] };
    });
  }

  /* ---------------------------- استخراج المرفقات ---------------------------- */
  function djb2(s){ var h=5381; for(var i=0;i<s.length;i++){ h=((h<<5)+h)^s.charCodeAt(i); } return (h>>>0).toString(36); }
  var MIME_EXT={'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp',
    'image/svg+xml':'svg','image/bmp':'bmp','application/pdf':'pdf','text/plain':'txt','text/csv':'csv',
    'application/json':'json','application/zip':'zip',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
    'application/msword':'doc','application/vnd.ms-excel':'xls'};
  function b64ToBytes(b64){
    var bin=atob(b64), len=bin.length, u=new Uint8Array(len);
    for(var i=0;i<len;i++) u[i]=bin.charCodeAt(i);
    return u;
  }
  // يجمع كل روابط data:*;base64 من أي نص داخل الكائن
  function scanDataUris(obj, bag){
    var re=/data:([-\w.+/]+);base64,([A-Za-z0-9+/=]+)/g;
    function walk(v){
      if(v==null) return;
      if(typeof v==='string'){
        var m; re.lastIndex=0;
        while((m=re.exec(v))!==null){
          var mime=m[1], payload=m[2];
          if(payload.length<64) continue;             // تجاهل الأيقونات الصغيرة
          var key=djb2(payload)+'_'+payload.length;
          if(!bag[key]) bag[key]={mime:mime, payload:payload};
        }
      } else if(typeof v==='object'){
        for(var k in v){ if(Object.prototype.hasOwnProperty.call(v,k)) walk(v[k]); }
      }
    }
    walk(obj);
  }
  function extractAttachments(root, snapshot){
    var bag={};
    // من التخزين المحلي (قِيَمه نصوص قد تكون JSON)
    for(var k in snapshot.localStorage){
      var val=snapshot.localStorage[k];
      scanDataUris(val, bag);
      try{ scanDataUris(JSON.parse(val), bag); }catch(e){}
    }
    scanDataUris(snapshot.indexedDB, bag);
    scanDataUris(snapshot.firebase, bag);

    var keys=Object.keys(bag);
    if(!keys.length) return Promise.resolve(0);

    // كل التطبيقات تشترك في نفس التخزين، فتُجمع المرفقات في مجلد واحد مع منع التكرار عالمياً
    return subDir(root,'مرفقات').then(function(attDir){
      var written=0, chain=Promise.resolve();
      keys.forEach(function(key){
        if(state.hashes[key]) return;                 // مكتوب سابقاً
        var it=bag[key]; var ext=MIME_EXT[it.mime]|| (it.mime.split('/')[1]||'bin').replace(/[^\w]+/g,'');
        var name=key+'.'+ext;
        chain=chain.then(function(){
          return writeFile(attDir, name, b64ToBytes(it.payload)).then(function(){
            state.hashes[key]=1; written++;
          }).catch(function(){});
        });
      });
      return chain.then(function(){ if(written) idbSet('hashes', state.hashes); return written; });
    }).catch(function(){ return 0; });
  }

  /* ---------------------------- الحفظ ---------------------------- */
  function pad(x){ return String(x).padStart(2,'0'); }
  function stamp(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'_'+pad(d.getHours())+'س'; }
  function pruneSnapshots(dir){
    if(!dir.entries) return Promise.resolve();
    var names=[];
    return (function(){ var it=dir.entries(); function step(){ return it.next().then(function(r){
        if(r.done) return; var e=r.value; if(e[1].kind==='file' && /^نسخة_شاملة_.*\.json$/.test(e[0])) names.push(e[0]); return step();
    }); } return step(); })().then(function(){
      names.sort();
      var extra=names.length-MAX_SNAPSHOTS;
      var chain=Promise.resolve();
      for(var i=0;i<extra;i++){ (function(nm){ chain=chain.then(function(){ return dir.removeEntry(nm).catch(function(){}); }); })(names[i]);
      }
      return chain;
    }).catch(function(){});
  }
  function doSave(interactive){
    if(!state.dir){ if(interactive) alert('لم يتم ربط مجلد بعد. اضغط «اربط مجلد الحفظ».'); return Promise.resolve(false); }
    if(state.busy) return Promise.resolve(false);
    state.busy=true; setChip('يحفظ…');
    return perm(state.dir, interactive).then(function(p){
      if(p!=='granted'){ state.busy=false; setChip('بانتظار الإذن'); if(interactive) alert('يجب السماح بالكتابة في المجلد.'); return false; }
      return buildSnapshot().then(function(snap){
        var json=JSON.stringify(snap,null,2);
        return writeFile(state.dir,'نسخة_شاملة_latest.json', new Blob([json],{type:'application/json'}))
          .then(function(){ return subDir(state.dir,'لقطات'); })
          .then(function(snapDir){ return writeFile(snapDir,'نسخة_شاملة_'+stamp(new Date())+'.json', new Blob([json])).then(function(){ return pruneSnapshots(snapDir); }); })
          .then(function(){ return extractAttachments(state.dir, snap); })
          .then(function(nAtt){
            var when=new Date().toLocaleString('ar-EG');
            var msg='آخر حفظ: '+when+' — من تطبيق: '+APP_ID+(nAtt?(' — مرفقات جديدة: '+nAtt):'');
            localStorage.setItem(LS_LAST, msg);
            return writeFile(state.dir,'آخر_حفظ.txt', new Blob([msg+'\n'])).then(function(){
              state.busy=false; setChip('محفوظ'); refreshPanel(); return true;
            });
          });
      });
    }).catch(function(e){ state.busy=false; setChip('خطأ'); if(interactive) alert('تعذّر الحفظ: '+(e&&e.message||e)); return false; });
  }
  function scheduleSave(){
    if(!state.auto || !state.dir) return;
    if(state.timer) clearTimeout(state.timer);
    state.timer=setTimeout(function(){ state.timer=null; doSave(false); }, DEBOUNCE_MS);
  }

  /* ---------- ترصّد تغيّر البيانات (ترقيع setItem) ---------- */
  var _set=localStorage.setItem.bind(localStorage);
  localStorage.setItem=function(k,v){ _set(k,v); if(k!==LS_LAST && k!==LS_AUTO) scheduleSave(); };

  /* ---------------------------- الاسترداد من الجهاز ---------------------------- */
  function restoreFromDevice(){
    if(!state.dir){ alert('اربط المجلد أولاً.'); return; }
    if(!confirm('سيقرأ الملف «نسخة_شاملة_latest.json» من المجلد ويستبدل بيانات هذا المتصفّح. متابعة؟')) return;
    perm(state.dir,true).then(function(p){ if(p!=='granted') return;
      readFile(state.dir,'نسخة_شاملة_latest.json').then(function(txt){
        var pack=JSON.parse(txt); var ls=pack.localStorage||{}; var keys=Object.keys(ls);
        keys.forEach(function(k){ _set(k, ls[k]); });
        alert('تمت الاستعادة: '+keys.length+' مفتاحاً. أعد فتح التطبيقات لرؤية البيانات.');
        location.reload();
      }).catch(function(e){ alert('تعذّرت القراءة: '+(e&&e.message||e)); });
    });
  }

  /* ---------------------------- ربط/فك المجلد ---------------------------- */
  function linkFolder(){
    if(!SUPPORTED){ alert('هذه الميزة تحتاج فتح التطبيق عبر متصفّح كروم/إيدج ومن رابط الموقع (وليس ملفاً محلياً).'); return; }
    window.showDirectoryPicker({mode:'readwrite'}).then(function(h){
      state.dir=h; return idbSet('dirHandle',h);
    }).then(function(){
      return idbGet('hashes');
    }).then(function(h){
      state.hashes=h||{};
      setChip('مربوط'); refreshPanel();
      // أول حفظ فوري
      doSave(true);
    }).catch(function(e){ if(e && e.name!=='AbortError') alert('تعذّر ربط المجلد: '+(e&&e.message||e)); });
  }
  function unlink(){
    idbSet('dirHandle',null); state.dir=null; setChip('غير مربوط'); refreshPanel();
  }
  function setAuto(on){
    state.auto=!!on; localStorage.setItem(LS_AUTO, on?'1':'0');
    refreshPanel();
    if(on) scheduleSave();
  }

  /* ============================ الواجهة ============================ */
  var chip, panel;
  function setChip(txt){
    if(!chip) return;
    var dot = !state.dir ? '#c0532f' : (state.auto ? '#2e9e5b' : '#c9a227');
    chip.querySelector('.sls-dot').style.background=dot;
    chip.querySelector('.sls-tx').textContent = txt || (!state.dir?'غير مربوط':(state.auto?'تلقائي':'يدوي'));
  }
  function refreshPanel(){
    if(!panel) return;
    var linked=!!state.dir;
    panel.querySelector('#sls-status').textContent = linked ? 'المجلد مربوط بهذا المتصفّح.' : 'لا يوجد مجلد مربوط بعد.';
    panel.querySelector('#sls-auto').checked = state.auto;
    panel.querySelector('#sls-last').textContent = localStorage.getItem(LS_LAST) || '—';
    panel.querySelector('#sls-link').textContent = linked ? 'تغيير المجلد' : 'اربط مجلد الحفظ';
    panel.querySelector('#sls-unlink').style.display = linked ? '' : 'none';
  }
  function buildUI(){
    var css=document.createElement('style');
    css.textContent=
    '.sls-chip{position:fixed;bottom:14px;left:14px;z-index:99997;display:flex;align-items:center;gap:8px;'+
    'padding:8px 13px;border-radius:999px;border:1px solid #b8921a;background:rgba(10,32,16,.92);'+
    'color:#f3ead0;font-family:"Cairo",system-ui,sans-serif;font-weight:700;font-size:12.5px;cursor:pointer;'+
    'box-shadow:0 6px 20px rgba(0,0,0,.4);backdrop-filter:blur(3px)}'+
    '.sls-dot{width:10px;height:10px;border-radius:50%;background:#c0532f;flex:0 0 auto}'+
    '.sls-ov{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(3,12,6,.55)}'+
    '.sls-ov.on{display:flex}'+
    '.sls-card{width:min(94vw,430px);background:linear-gradient(180deg,#11331c,#0d2917);border:1px solid #1d4a2c;'+
    'border-radius:16px;padding:22px;color:#f3ead0;font-family:"Cairo",system-ui,sans-serif;direction:rtl;box-shadow:0 22px 60px rgba(0,0,0,.5)}'+
    '.sls-card h3{margin:0 0 4px;font-size:17px;color:#f3ead0}'+
    '.sls-card p{margin:0 0 14px;color:#9db3a3;font-size:12.5px;line-height:1.9}'+
    '.sls-b{display:inline-flex;align-items:center;gap:7px;border:1px solid #b8921a;color:#d8b441;background:#0c2413;'+
    'border-radius:10px;padding:9px 14px;font-family:inherit;font-weight:700;font-size:13px;cursor:pointer;margin:4px 4px 4px 0}'+
    '.sls-b.solid{background:#d8b441;color:#1a1405}'+
    '.sls-b.ghost{border-color:#1d4a2c;color:#9db3a3}'+
    '.sls-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-top:1px solid #1d4a2c}'+
    '.sls-sw{position:relative;width:46px;height:26px;flex:0 0 auto}'+
    '.sls-sw input{opacity:0;width:0;height:0}'+
    '.sls-sl{position:absolute;inset:0;background:#0a1f11;border:1px solid #1d4a2c;border-radius:999px;transition:.2s;cursor:pointer}'+
    '.sls-sl:before{content:"";position:absolute;height:18px;width:18px;right:3px;top:3px;background:#9db3a3;border-radius:50%;transition:.2s}'+
    '.sls-sw input:checked + .sls-sl{background:#123b20;border-color:#2e9e5b}'+
    '.sls-sw input:checked + .sls-sl:before{transform:translateX(-20px);background:#2e9e5b}'+
    '.sls-last{font-size:12px;color:#9db3a3;background:#08160d;border:1px solid #1d4a2c;border-radius:10px;padding:9px 12px;line-height:1.8;word-break:break-word}'+
    '@media print{.sls-chip,.sls-ov{display:none !important}}';
    document.head.appendChild(css);

    chip=document.createElement('div'); chip.className='sls-chip';
    chip.innerHTML='<span class="sls-dot"></span><span class="sls-tx">حفظ الجهاز</span>';
    chip.addEventListener('click',function(){ panel.classList.add('on'); refreshPanel(); });
    document.body.appendChild(chip);

    var ov=document.createElement('div'); ov.className='sls-ov';
    ov.innerHTML=
    '<div class="sls-card">'+
      '<h3>الحفظ الدائم على الجهاز</h3>'+
      '<p>يحفظ نسخة كاملة من بيانات كل التطبيقات ومرفقاتها داخل مجلد تختاره على جهازك. النسخة دائمة وتُحدَّث مع كل تغيير عند تفعيل الحفظ التلقائي.</p>'+
      '<div id="sls-status" class="sls-last" style="margin-bottom:12px">—</div>'+
      '<div><button class="sls-b solid" id="sls-link">اربط مجلد الحفظ</button>'+
      '<button class="sls-b" id="sls-save">احفظ الآن</button>'+
      '<button class="sls-b ghost" id="sls-restore">استرداد من الجهاز</button>'+
      '<button class="sls-b ghost" id="sls-unlink" style="display:none">فكّ الربط</button></div>'+
      '<div class="sls-row"><span>الحفظ التلقائي عند كل تغيير</span>'+
        '<label class="sls-sw"><input type="checkbox" id="sls-auto"><span class="sls-sl"></span></label></div>'+
      '<div style="margin:12px 0 4px;font-size:12px;color:#d8b441;font-weight:700">آخر عملية حفظ</div>'+
      '<div id="sls-last" class="sls-last">—</div>'+
      '<div style="text-align:left;margin-top:16px"><button class="sls-b ghost" id="sls-close">إغلاق</button></div>'+
    '</div>';
    document.body.appendChild(ov); panel=ov;
    ov.addEventListener('click',function(e){ if(e.target===ov) ov.classList.remove('on'); });
    ov.querySelector('#sls-close').addEventListener('click',function(){ ov.classList.remove('on'); });
    ov.querySelector('#sls-link').addEventListener('click',linkFolder);
    ov.querySelector('#sls-unlink').addEventListener('click',unlink);
    ov.querySelector('#sls-save').addEventListener('click',function(){ doSave(true); });
    ov.querySelector('#sls-restore').addEventListener('click',restoreFromDevice);
    ov.querySelector('#sls-auto').addEventListener('change',function(e){ setAuto(e.target.checked); });

    if(!SUPPORTED){ chip.querySelector('.sls-tx').textContent='حفظ يدوي'; }
  }

  /* ---------------------------- الإقلاع ---------------------------- */
  function boot(){
    if(document.getElementById('authGate') && document.getElementById('authGate').style.display!=='none'){
      // ننتظر تجاوز شاشة الدخول
    }
    buildUI();
    Promise.all([idbGet('dirHandle'), idbGet('hashes')]).then(function(r){
      state.dir=r[0]||null; state.hashes=r[1]||{};
      if(state.dir){
        perm(state.dir,false).then(function(p){
          setChip(p==='granted'?(state.auto?'تلقائي':'مربوط'):'بانتظار الإذن');
          if(p==='granted' && state.auto){ scheduleSave(); }
          else if(p!=='granted'){
            // نحتاج نقرة مستخدم لاستعادة الإذن — تُستأنف عند فتح اللوحة أو أي نقرة على الشريحة
          }
        });
      } else { setChip('غير مربوط'); }
    }).catch(function(){ setChip('غير مربوط'); });
  }

  // نبني الواجهة بعد أن يجهز الجسم
  if(document.body){ boot(); }
  else { document.addEventListener('DOMContentLoaded', boot); }

  // كشف واجهة برمجية بسيطة
  window.SaadLS={ save:function(){return doSave(true);}, link:linkFolder, auto:setAuto, status:function(){return {linked:!!state.dir,auto:state.auto};} };
})();
