const $ = id => document.getElementById(id);
const ctx = new AudioContext({sampleRate: 44100});
const stamp = t => Math.floor(t / 60).toString().padStart(2, "0") + ":" + (t % 60).toFixed(1).padStart(4, "0");
const seconds = t => Number(t).toFixed(2);
const node = (tag, cls, value) => {
  const el = document.createElement(tag);
  el.className = cls;
  el.textContent = value;
  return el;
};
const action = (label, fn) => {
  const el = node("button", "", label);
  el.onclick = fn;
  return el;
};
let original, edited, words = [], lines = [], suggestions = [], cuts = [], history = [], hidden = [];
let job = "", title = "", busy = false, lo = null, hi = null, cursor = 0, zoom = 1, viewStart = 0;
let splits = [], pauses = [], selectedPause = null;
let audioPlan = [], outputFrames = 0, resumeAt = null;
const hasRange = () => lo !== null && hi !== null && hi > lo;
let player = null, mode = "", since = 0, seekStart = 0, seekEnd = 0, frame = 0, lastWord = -1;
let drag = null, peaks = [], lastJoin = null;
const status = text => { $("status").textContent = text; };
const total = () => original?.duration || 0;
const cutSeconds = () => cuts.reduce((sum, [a,b]) => sum + b - a, 0);
const remaining = () => original ? outputFrames/original.sampleRate : 0;
const normalized = s => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
function joinCuts(ranges) {
  const merged = [];
  for (let [a,b] of ranges.slice().sort((x,y) => x[0]-y[0])) {
    a = Math.max(0, a); b = Math.min(total(), b);
    if (b <= a) continue;
    const last = merged.at(-1);
    if (last && a <= last[1] + 0.00001) last[1] = Math.max(last[1], b);
    else merged.push([a,b]);
  }
  return merged;
}
function keepRanges() {
  const keep = [];
  let start = 0;
  for (const [a,b] of cuts) { if (a > start) keep.push([start,a]); start = b; }
  if (start < total()) keep.push([start,total()]);
  return keep;
}
const removedBefore = t => cuts.reduce((v,[a,b]) => v + Math.max(0, Math.min(t,b)-a), 0);
const isCut = w => removedBefore(w.end)-removedBefore(w.start) >= (w.end-w.start)/2;
function rebuildAudioPlan() {
  const sr=original.sampleRate;
  const frame=t=>Math.round(t*sr);
  const ranges=keepRanges().map(([a,b])=>[frame(a),frame(b)]);
  const gaps=pauses.map(pause=>({pause,a:frame(pause.at),b:frame(pause.at),length:frame(pause.duration)}));
  const clips=[];
  let gapIndex=0;
  for(const [start,end] of ranges) {
    let a=start;
    while(gapIndex<gaps.length && gaps[gapIndex].a<=start) gapIndex++;
    while(gapIndex<gaps.length && gaps[gapIndex].a<end) {
      const b=gaps[gapIndex++].a;
      if(b>a) clips.push({a,b,length:b-a});
      a=b;
    }
    if(end>a) clips.push({a,b:end,length:end-a});
  }
  audioPlan=[...clips,...gaps].sort((x,y)=>x.a-y.a||x.b-y.b);
  outputFrames=0;
  for(const clip of audioPlan) {
    clip.offset=outputFrames;
    outputFrames+=clip.length;
  }
  edited=null;
  resumeAt=null;
}
function mapped(t, afterPause=false) {
  const sr=original.sampleRate, frame=Math.round(t*sr);
  for(const clip of audioPlan) {
    if(frame<clip.a || (clip.pause && frame===clip.a && !afterPause)) return clip.offset/sr;
    if(frame<clip.b) return (clip.offset+frame-clip.a)/sr;
  }
  return remaining();
}
function splitLines() {
  lines = [];
  let line;
  words.forEach((w,i) => {
    const prev = words[i-1];
    if (!line || /[。！？.!?]["”’]?$/.test(prev.text.trim()) ||
        w.start-prev.end > 0.9 || (line.text.length > 30 && /[，,、；;]$/.test(prev.text.trim())) ||
        line.text.length >= 65) {
      line = {start:w.start,end:w.end,text:"",ids:[]}; lines.push(line);
    }
    line.text += w.text; line.end = w.end; line.ids.push(i);
  });
}
function findSuggestions() {
  suggestions = [];
  for (let i=0; i<lines.length-1; i++) {
    const group = [lines[i]], seed = normalized(lines[i].text);
    let j=i+1;
    for (;j<lines.length;j++) {
      const next = normalized(lines[j].text);
      let n=0;
      while(n<seed.length && n<next.length && seed[n]===next[n]) n++;
      if (lines[j].start-group.at(-1).end > 4 || n < 3 || n < Math.min(seed.length,next.length)*0.45) break;
      group.push(lines[j]);
    }
    if(group.length>1) {suggestions.push({type:"重录",group}); i=j-1;}
  }
  for (let i=0;i<words.length-1;i++) {
    const t=normalized(words[i].text);
    if (!t || t.length>4) continue;
    let j=i+1;
    while(j<words.length && words[j].start-words[j-1].end<0.85 && normalized(words[j].text)===t) j++;
    const separated = /[，,、；;]$/.test(words[i].text.trim()) || (j>i+1 && words[i+1].start-words[i].end > .18);
    if(j>i+1 && (t.length>1 || j-i>=3 || separated)) {
      const line = lines.find(row=>row.ids.includes(i));
      suggestions.push({type:"叠词",a:words[i].start,b:words[j-1].start,end:words[j-1].end,
        text:line.text});
      i=j-1;
    }
  }
}
function save() {
  try {localStorage.setItem("takecut-session", JSON.stringify({job,title,cuts,hidden,splits,pauses}));} catch {}
}
function rememberEdit() {
  history.push({cuts,hidden,splits,pauses,selectedPause,lo,hi,lastJoin});
}
function apply(ranges, key, replacementPause) {
  const next=joinCuts(cuts.concat(ranges));
  if (total()-next.reduce((s,[a,b])=>s+b-a,0)<0.02) {status("至少保留一小段声音才能导出。"); return;}
  stop(); rememberEdit();
  cuts=next; hidden=key===undefined?hidden:hidden.concat(key);
  const f=t=>Math.round(t*original.sampleRate);
  pauses=pauses.filter(p=>!cuts.some(([a,b])=>f(a)<f(p.at)&&f(p.at)<f(b)));
  if(replacementPause) {
    // Anchor against the merged cuts, so a selection that overlaps an existing cut puts the pause at the merged cut's end.
    setPauseAt({at:pauseAnchor(replacementPause.end),duration:replacementPause.duration});
    setPauseFields(replacementPause.duration);
  }
  rebuildAudioPlan();
  if(ranges.length) lastJoin=ranges[0][0];
  lo=hi=null; save(); render(); status("已更新剪辑，可试听剪后或撤销。");
}
function keepTake(group, pick, key) {
  const discarded = group.flatMap((line,i) => {
    if(i===pick) return [];
    const next = lines[lines.indexOf(line)+1];
    // Include the pause after a rejected take, leaving a short breath before the next line.
    const end = next ? Math.max(line.end, next.start-0.08) : line.end;
    return [[Math.max(0,line.start-0.035),end]];
  });
  apply(discarded,key);
}
function renderReviews() {
  const box=$("reviews"); box.replaceChildren();
  suggestions.forEach((s,k)=>{
    if(hidden.includes(k) || (!s.group && isCut({start:s.a,end:s.end}))) return;
    const card=node("div","review",""); card.append(node("strong","",s.type==="重录"?"相似开头 · "+s.group.length+" 遍":"可能的重复词"));
    if(s.group) {
      s.group.forEach((line,i)=>{
        const take=node("div","take",""); take.append(node("p","",line.text),
          action("▶ 第 "+(i+1)+" 遍",()=>play("timeline",Math.max(0,line.start-.06),Math.min(total(),line.end+.12))),
          action("只留这遍",()=>keepTake(s.group,i,k))); card.append(take);
      });
    } else {
      card.append(node("p","",s.text),action("▶ 回听",()=>play("timeline",Math.max(0,s.a-.3),Math.min(total(),s.end+.65))),
        action("剪掉前面的重复",()=>apply([[s.a,s.b]],k)));
    }
    card.append(action("全部保留",()=>apply([],k))); box.append(card);
  });
  $("reviewCount").textContent=box.children.length+" 处";
  if (!box.children.length) box.append(node("p","empty","没有待确认的建议。仍可在逐字稿或波形中手动选剪。"));
}
function render() {
  const box=$("rows"); const scroll=box.scrollTop; box.replaceChildren();
  lines.forEach(line=>{
    const row=node("div","row",""); const t=action(stamp(line.start),()=>play("timeline",line.start,line.end));
    t.className="time"; t.title="试听整句"; row.append(t);
    const group=node("div","words","");
    line.ids.forEach(i=>{
      const w=words[i], span=node("span","word"+(isCut(w)?" deleted":""),w.text);
      span.dataset.i=i; group.append(span);
    }); row.append(group); box.append(row);
  });
  if (!lines.length) box.append(node("p","empty","没有识别到文字，可在波形上选取时间段。"));
  box.scrollTop=scroll; lastWord=-1;
  $("lineCount").textContent=lines.length+" 句"; $("duration").textContent=stamp(total());
  $("removed").textContent=cutSeconds().toFixed(1)+" 秒"; $("resultTime").textContent=stamp(remaining());
  $("undo").disabled=!history.length||busy; $("wav").disabled=$("play").disabled=$("preview").disabled=!original||busy;
  $("srt").disabled=busy||!words.some(w=>!isCut(w)); $("join").hidden=lastJoin===null;
  renderReviews(); renderPauses(); updateSelection();
}
function updateSelection(writeFields=true) {
  if(writeFields) {
    $("start").value=lo===null?"":seconds(lo);
    $("end").value=hi===null?"":seconds(hi);
  }
  const valid=hasRange(), unavailable=busy||!original;
  $("cut").disabled=$("listenSel").disabled=!valid||unavailable;
  $("split").disabled=$("markIn").disabled=$("markOut").disabled=unavailable;
  $("clearMarks").disabled=unavailable||(lo===null&&hi===null);
  $("replacePause").disabled=unavailable||!valid;
  $("rangeTime").textContent=valid?"已选 "+seconds(hi-lo)+" 秒":lo!==null?"等待出点":hi!==null?"等待入点":"";
  document.querySelectorAll(".word").forEach(el=>{
    const w=words[+el.dataset.i]; el.classList.toggle("selected",valid && w.end>lo+.00001 && w.start<hi-.00001);
  }); draw();
}
function setSelection(a,b) {lo=Math.max(0,Math.min(a,b)); hi=Math.min(total(),Math.max(a,b)); updateSelection();}
for(const id of ["start","end"]) $(id).oninput=()=>{
  const read=id=>$(id).value===""?null:Math.min(total(),Math.max(0,Number($(id).value)));
  lo=read("start"); hi=read("end"); updateSelection(false);
};
$("clearMarks").onclick=()=>{lo=hi=null;updateSelection();};
function headTime() {
  if(!player) return cursor;
  return sourceTime(position());
}
function mark(inPoint) {
  const t=headTime();
  if(inPoint) {lo=t;if(hi!==null&&hi<=t)hi=null;}
  else {hi=t;if(lo!==null&&lo>=t)lo=null;}
  updateSelection();
}
$("markIn").onclick=()=>mark(true);
$("markOut").onclick=()=>mark(false);
$("split").onclick=()=>{
  const t=headTime(), edge=0.001;
  if(!keepRanges().some(([a,b])=>t>a+edge&&t<b-edge)||splits.some(s=>Math.abs(s-t)<edge)) {
    status("请把播放头移到保留片段的中间再分割。");return;
  }
  rememberEdit();
  splits=[...splits,t].sort((a,b)=>a-b);
  lo=hi=null;save();render();status("已在 "+seconds(t)+" 秒处分割。双击波形可选中一段。");
};
$("cut").onclick=()=>apply([[lo,hi]]);
$("listenSel").onclick=()=>play("timeline",lo,hi);
$("undo").onclick=()=>{
  if(!history.length) return;
  stop();
  ({cuts,hidden,splits,pauses,selectedPause,lo,hi,lastJoin}=history.pop());
  rebuildAudioPlan();
  const pause=currentPause();
  if(pause) setPauseFields(pause.duration);
  save(); render(); status("已撤销上一步。");
};
$("rows").onpointerup=e=>{
  const sel=window.getSelection();
  const wordAt=n=>(n?.nodeType===3?n.parentElement:n)?.closest?.(".word");
  const a=wordAt(sel.anchorNode), b=wordAt(sel.focusNode);
  if(!sel.isCollapsed && a && b) {
    const first=Math.min(+a.dataset.i,+b.dataset.i), last=Math.max(+a.dataset.i,+b.dataset.i);
    setSelection(words[first].start,words[last].end); sel.removeAllRanges(); return;
  }
  const el=wordAt(e.target); if(!el) return;
  const w=words[+el.dataset.i]; setSelection(w.start,w.end);
  play("timeline",w.start,Math.min(total(),w.end+.45));
};
function setPauseAt(pause) {
  pauses=[...pauses.filter(p=>p.at!==pause.at),pause].sort((a,b)=>a.at-b.at);
  selectedPause=pause.at;
}
function renderPauses() {
  const list=$("pauseList");
  list.replaceChildren();
  list.hidden=!pauses.length;
  for(const pause of pauses) {
    const button=action(stamp(pause.at)+" · "+seconds(pause.duration)+" 秒",()=>selectPause(pause));
    button.setAttribute("aria-pressed",String(pause.at===selectedPause));
    button.disabled=busy;
    list.append(button);
  }
  $("pauseActions").hidden=!pauses.some(p=>p.at===selectedPause);
  $("insertPause").disabled=busy||!original;
}
function setPauseFields(duration) {
  $("pauseLength").value=seconds(duration);
  $("pauseSlider").max=Math.max(2,Math.ceil(duration));
  $("pauseSlider").value=duration;
}
function selectPause(pause) {
  stop();
  resumeAt=mapped(pause.at);
  selectedPause=cursor=pause.at;
  $("pauseEditor").open=true;
  setPauseFields(pause.duration);
  renderPauses();
  draw();
}
function pauseLength(allowZero=false) {
  const input=$("pauseLength"), duration=input.valueAsNumber;
  if(Number.isFinite(duration)&&duration>=(allowZero?0:.01)&&duration<=60) return duration;
  status("请输入 "+(allowZero?"0":"0.01")+" 到 60 秒之间的时长。");
  return null;
}
function pauseAnchor(time) {
  const sr=original.sampleRate;
  const cut=cuts.find(([a,b])=>a<=time&&time<b);
  return Math.round((cut?.[1]??time)*sr)/sr;
}
function updatePause(pause, duration) {
  if(duration===null || pause?.duration===duration) return;
  stop();
  rememberEdit();
  const at=pause?.at??pauseAnchor(cursor);
  if(duration>0) {
    setPauseAt({at,duration});
    setPauseFields(duration);
  } else {
    pauses=pauses.filter(p=>p.at!==at);
    selectedPause=null;
  }
  cursor=at;
  lastJoin=at;
  rebuildAudioPlan();
  resumeAt=mapped(at);
  save();
  render();
  status(duration>0?"气口已设为 "+seconds(duration)+" 秒。":"已删除气口。");
}
for(const button of document.querySelectorAll("[data-pause-length]")) {
  button.onclick=()=>setPauseFields(Number(button.dataset.pauseLength));
}
$("insertPause").onclick=()=>{
  const duration=pauseLength();
  if(duration===null) return;
  const at=pauseAnchor(headTime());
  updatePause(pauses.find(p=>p.at===at)??{at},duration);
};
$("replacePause").onclick=()=>{
  const duration=pauseLength(true);
  if(duration===null) return;
  apply([[lo,hi]],undefined,duration>0?{end:hi,duration}:undefined);
};
const currentPause=()=>pauses.find(p=>p.at===selectedPause);
$("resizePause").onclick=()=>updatePause(currentPause(),pauseLength());
$("deletePause").onclick=()=>updatePause(currentPause(),0);
$("pauseSlider").oninput=()=>{$("pauseLength").value=seconds($("pauseSlider").valueAsNumber);};
$("pauseSlider").onchange=()=>updatePause(currentPause(),$("pauseSlider").valueAsNumber);
$("reviewPause").onclick=()=>{
  if(mode==="pause"){stop();draw();return;}
  const pause=currentPause();
  const start=mapped(pause.at), end=mapped(pause.at,true);
  play("pause",Math.max(0,start-1),Math.min(remaining(),end+1));
};
function buildEdited() {
  if(edited) return edited;
  if(!cuts.length&&!pauses.length) return original;
  const sr=original.sampleRate;
  const out=ctx.createBuffer(original.numberOfChannels,outputFrames,sr);
  for(let ch=0;ch<out.numberOfChannels;ch++) {
    const src=original.getChannelData(ch), dst=out.getChannelData(ch);
    for(const {a,b,length:len,offset:pos,pause} of audioPlan) {
      if(pause) continue;
      const fade=Math.min(Math.floor(len/2),Math.round(sr*.003));
      dst.set(src.subarray(a,b),pos);
      for(let j=0;j<fade;j++) {
        if(a>0||pos>0) dst[pos+j]*=j/fade;
        if(b<original.length||pos+len<outputFrames) dst[pos+len-1-j]*=j/fade;
      }
    }
  }
  edited=out; return out;
}
function position() {
  const elapsed=Math.max(0,ctx.currentTime-since);
  return mode==="pause"?seekStart+elapsed%(seekEnd-seekStart):Math.min(seekEnd,seekStart+elapsed);
}
function sourceTime(t) {
  const sr=original.sampleRate, frame=Math.round(t*sr);
  for(const clip of audioPlan) {
    if(frame<clip.offset+clip.length) return (clip.a+(clip.pause?0:Math.max(0,t*sr-clip.offset)))/sr;
  }
  return total();
}
function stop() {
  if(player) {
    cursor=headTime();
    resumeAt=position();
    player.onended=null; player.stop(); player=null;
  }
  cancelAnimationFrame(frame); $("play").textContent="▶ 播放"; $("preview").textContent="试听剪后"; $("join").textContent="试听剪点"; $("reviewPause").textContent="循环试听"; mode="";
}
async function play(type,a,b) {
  if(!original || busy) return;
  stop(); await ctx.resume(); stop();
  const buf=buildEdited();
  if(type==="timeline"){
    a=mapped(a); b=mapped(b,b===total());
  }
  a=Math.max(0,Math.min(buf.duration,a)); b=Math.min(b,buf.duration);
  if(Math.round(b*buf.sampleRate)<=Math.round(a*buf.sampleRate)){
    cursor=sourceTime(a);draw();return;
  }
  mode=type; seekStart=a;seekEnd=b;since=ctx.currentTime;
  resumeAt=null;
  player=ctx.createBufferSource();player.buffer=buf;player.connect(ctx.destination);
  player.onended=()=>{cursor=sourceTime(b);player=null;stop();draw();};
  if(type==="pause") {
    player.loop=true;player.loopStart=a;player.loopEnd=b;
    player.start(0,a);
  } else {
    player.start(0,a,b-a);
  }
  $({pause:"reviewPause",edited:"preview",join:"join"}[type]??"play").textContent="Ⅱ 暂停";
  function tick(){if(!player) return; cursor=headTime(); draw(); frame=requestAnimationFrame(tick);}
  tick();
}
$("play").onclick=()=>{
  if(player){stop();draw();return;}
  const start=resumeAt??(cursor>=total()?0:mapped(cursor));
  play("transport",start,remaining());
};
$("preview").onclick=()=>{if(mode==="edited"){stop();draw();}else play("edited",0,remaining());};
$("join").onclick=()=>{
  if(mode==="join"){stop();draw();return;}
  const join=mapped(lastJoin), end=mapped(lastJoin,true);
  play("join",Math.max(0,join-1.5),Math.min(remaining(),end+2));
};
function buildPeaks() {
  const data=original.getChannelData(0), step=128;
  peaks=new Float32Array(Math.ceil(data.length/step));
  for(let i=0;i<data.length;i++) {const k=Math.floor(i/step); peaks[k]=Math.max(peaks[k],Math.abs(data[i]));}
}
function draw() {
  const canvas=$("wave"), rect=canvas.getBoundingClientRect(); if(!rect.width||!original)return;
  const ratio=window.devicePixelRatio||1,w=Math.round(rect.width*ratio),h=Math.round(rect.height*ratio);
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  const g=canvas.getContext("2d"), span=total()/zoom;
  if(!drag && (cursor<viewStart || cursor>viewStart+span)) viewStart=Math.max(0,Math.min(total()-span,cursor-span*.2));
  const x=t=>(t-viewStart)/span*w;
  g.clearRect(0,0,w,h);g.fillStyle="#638276";g.fillRect(0,h/2,w,1);
  const stride=Math.max(2,Math.round(3*ratio)), rate=original.sampleRate/128;
  for(let i=0;i<w;i+=stride) {
    const a=Math.floor((viewStart+i/w*span)*rate), b=Math.min(peaks.length,Math.ceil((viewStart+(i+stride)/w*span)*rate));
    let amp=0;for(let k=a;k<b;k++)amp=Math.max(amp,peaks[k]||0);
    const height=Math.max(2,Math.min(.95,Math.sqrt(amp))*h*.89);
    g.fillStyle="#a8d68a";g.fillRect(i,(h-height)/2,Math.max(1,stride-ratio),height);
  }
  for(const [a,b] of cuts){g.fillStyle="rgba(210,110,90,.5)";g.fillRect(x(a),0,x(b)-x(a),h);}
  if(hasRange()){g.fillStyle="rgba(251,194,83,.38)";g.fillRect(x(lo),0,x(hi)-x(lo),h);}
  for(const t of splits){g.fillStyle="#68c6e0";g.fillRect(x(t)-ratio,0,2*ratio,h);g.fillRect(x(t)-3*ratio,0,6*ratio,5*ratio);}
  for(const pause of pauses) {
    const px=x(pause.at);
    g.fillStyle=pause.at===selectedPause?"#f1ccff":"#cb9fe9";
    g.fillRect(px-ratio,0,2*ratio,h);
    g.fillRect(px-5*ratio,0,10*ratio,8*ratio);
  }
  for(const [t,label] of [[lo,"I"],[hi,"O"]]) {
    if(t===null)continue;
    const px=x(t);g.fillStyle="#f8cb73";g.fillRect(px,0,ratio,h);
    const tagX=Math.max(0,Math.min(w-14*ratio,px));
    if(px>=0&&px<=w){g.fillRect(tagX,0,14*ratio,16*ratio);g.fillStyle="#21392e";g.font="bold "+12*ratio+"px monospace";g.fillText(label,tagX+3*ratio,12*ratio);}
  }
  g.fillStyle="#f9efcf";g.fillRect(x(cursor),0,2*ratio,h);
  $("leftTick").textContent=stamp(viewStart);$("midTick").textContent=stamp(viewStart+span/2);$("rightTick").textContent=stamp(viewStart+span);
  // The clock follows the edited timeline (what playback actually plays), so it keeps running through pauses.
  const hundredths=Math.round((player?position():resumeAt??mapped(cursor))*100);
  $("clock").textContent=String(Math.floor(hundredths/6000)).padStart(2,"0")+":"+(hundredths%6000/100).toFixed(2).padStart(5,"0");
  $("duration").textContent=stamp(remaining());
  let low=0,high=words.length;
  while(low<high){const mid=(low+high)>>1;if(words[mid].end<=cursor)low=mid+1;else high=mid;}
  const active=words[low]?.start<=cursor &&
    !(player&&audioPlan.some(clip=>clip.pause&&cursor===clip.pause.at))?low:-1;
  if(active!==lastWord){document.querySelector(".word.active")?.classList.remove("active");document.querySelector('.word[data-i="'+active+'"]')?.classList.add("active");lastWord=active;}
}
function setZoom(factor){if(!original)return;zoom=Math.max(1,Math.min(64,zoom*factor));const span=total()/zoom;
  viewStart=Math.max(0,Math.min(total()-span,cursor-span/2));$("scale").textContent=zoom===1?"全段":zoom+"×";draw();}
$("zoomIn").onclick=()=>setZoom(2);$("zoomOut").onclick=()=>setZoom(.5);
const wave=$("wave");
function wavePos(e){const r=wave.getBoundingClientRect();return Math.max(0,Math.min(total(),viewStart+Math.min(1,Math.max(0,(e.clientX-r.left)/r.width))*total()/zoom));}
wave.onpointerdown=e=>{if(!original||busy)return;stop();resumeAt=null;drag={x:e.clientX,t:wavePos(e)};wave.setPointerCapture(e.pointerId);};
wave.onpointermove=e=>{if(drag && Math.abs(e.clientX-drag.x)>2){lo=Math.min(drag.t,wavePos(e));hi=Math.max(drag.t,wavePos(e));draw();}};
wave.onpointerup=e=>{
  if(!drag)return;
  const t=wavePos(e),clicked=Math.abs(e.clientX-drag.x)<3;
  if(clicked) cursor=t;
  else {lo=Math.min(t,drag.t);hi=Math.max(t,drag.t);cursor=lo;}
  drag=null;
  if(clicked) {
    const tolerance=7*total()/zoom/wave.getBoundingClientRect().width;
    const nearest=pauses.reduce((closest,p)=>Math.abs(p.at-t)<Math.abs((closest?.at??Infinity)-t)?p:closest,null);
    if(nearest&&Math.abs(nearest.at-t)<=tolerance) selectPause(nearest);
  }
  updateSelection();
};
wave.ondblclick=e=>{
  if(!original||busy)return;
  const t=wavePos(e), range=keepRanges().find(([a,b])=>a<=t&&t<b);
  if(!range){status("这段声音已剪掉。");return;}
  const bounds=[range[0],...splits.filter(s=>s>range[0]&&s<range[1]),range[1]];
  const next=bounds.findIndex(s=>s>t);
  setSelection(bounds[next-1],bounds[next]);
};
wave.onpointercancel=()=>{drag=null;updateSelection();};window.addEventListener("resize",draw);
function download(blob,ext) {
  const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=title+"-剪后."+ext;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
$("wav").onclick=()=>{
  const b=buildEdited(), channels=b.numberOfChannels, byteLen=b.length*channels*2;
  const header=new ArrayBuffer(44), v=new DataView(header);
  const tag=(i,s)=>Array.from(s).forEach((c,k)=>v.setUint8(i+k,c.charCodeAt(0)));
  tag(0,"RIFF");v.setUint32(4,36+byteLen,true);tag(8,"WAVE");tag(12,"fmt ");v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,b.sampleRate,true);v.setUint32(28,b.sampleRate*channels*2,true);
  v.setUint16(32,channels*2,true);v.setUint16(34,16,true);tag(36,"data");v.setUint32(40,byteLen,true);
  const chunks=[header], arrays=Array.from({length:channels},(_,i)=>b.getChannelData(i));
  for(let base=0;base<b.length;base+=65536) {const n=Math.min(65536,b.length-base), pcm=new Int16Array(n*channels);
    for(let i=0;i<n;i++)for(let c=0;c<channels;c++){const f=Math.max(-1,Math.min(1,arrays[c][base+i]));pcm[i*channels+c]=Math.round(f*(f<0?32768:32767));} chunks.push(pcm);}
  download(new Blob(chunks,{type:"audio/wav"}),"wav");
};
function srtTime(sec){let ms=Math.round(sec*1000);return [Math.floor(ms/3600000),Math.floor(ms/60000)%60,Math.floor(ms/1000)%60].map(x=>String(x).padStart(2,"0")).join(":")+","+String(ms%1000).padStart(3,"0");}
$("srt").onclick=()=>{
  const cues=[];
  const addCue=tokens=>{
    if(!tokens.length)return;
    const start=mapped(tokens[0].start,true), end=mapped(tokens.at(-1).end);
    if(srtTime(start)===srtTime(end)) return;
    cues.push((cues.length+1)+"\r\n"+srtTime(start)+" --> "+srtTime(end)+"\r\n"+tokens.map(w=>w.text).join("").trim());
  };
  for(const line of lines) {
    let tokens=[];
    for(const i of line.ids) {
      const w=words[i], prev=tokens.at(-1);
      if(isCut(w))continue;
      if(prev&&pauses.some(p=>p.at>prev.start&&p.at<=w.start)) {
        addCue(tokens);
        tokens=[];
      }
      tokens.push(w);
    }
    addCue(tokens);
  }
  download(new Blob(["\uFEFF"+cues.join("\r\n\r\n")+"\r\n"],{type:"application/x-subrip;charset=utf-8"}),"srt");
};
function busyState(value){busy=value;$("import").disabled=$("demo").disabled=value;
  for(const id of ["play","preview","wav","srt","undo","cut","listenSel","markIn","markOut","split","clearMarks"])$(id).disabled=true;
  for(const el of [$("reviews"),$("rows"),$("start"),$("end"),$("pauseEditor")])el.inert=value;
  if(!value) render();
}
async function load(id,label,saved) {
  const [audioRes,wordRes]=await Promise.all([fetch("/media/"+id+"/source.wav"),fetch("/media/"+id+"/words.json")]);
  if(!audioRes.ok||!wordRes.ok)throw Error("上次录音已过期，请重新导入。");
  const [buf,tokens]=await Promise.all([audioRes.arrayBuffer().then(b=>ctx.decodeAudioData(b)),wordRes.json()]);
  stop();original=buf;words=tokens;edited=null;lastJoin=null;job=id;title=label;cursor=viewStart=0;lo=hi=null;zoom=1;history=[];
  splits=(saved?.splits||[]).filter(t=>Number.isFinite(t)&&t>0&&t<total());
  cuts=joinCuts(saved?.cuts||[]);hidden=saved?.hidden||[];lastWord=-1;
  pauses=(saved?.pauses||[]).filter(p=>Number.isFinite(p.at)&&p.at>=0&&p.at<=total()&&
    Number.isFinite(p.duration)&&p.duration>=.01&&p.duration<=60).sort((a,b)=>a.at-b.at);
  selectedPause=null;
  rebuildAudioPlan();
  $("name").textContent=title;$("kind").textContent=id==="demo"?"示例录音 · 合成人声":"我的录音";$("scale").textContent="全段";
  splitLines();findSuggestions();buildPeaks();save();
  status("Whisper 转录 · "+stamp(total())+" · 拖入文件可切换录音");render();
}
async function upload(file) {
  if(!file||busy)return;
  if(!file.size||file.size>128*1024*1024){status("请选择 128 MiB 以内的非空录音。");return;}
  stop();busyState(true);status("正在导入 "+file.name+"…");
  try{
    const r=await fetch("/import",{method:"POST",headers:{"X-Takecut":"1"},body:file}),data=await r.json();
    if(!r.ok)throw Error(data.info);
    for(;;){const res=await fetch("/status/"+data.id);if(!res.ok)throw Error("转录服务已中断，请重新导入。");
      const state=await res.json();if(state.state==="ready")break;if(state.state==="error")throw Error(state.info);
      status(state.info);await new Promise(done=>setTimeout(done,800));}
    await load(data.id,file.name.replace(/\.[^.]+$/,""));
  } catch(err){status(err.message);}finally{busyState(false);$("file").value="";}
}
$("import").onclick=()=>$("file").click();$("file").onchange=e=>upload(e.target.files[0]);
let enters=0;
window.addEventListener("dragenter",e=>{if(e.dataTransfer.types.includes("Files")){e.preventDefault();enters++;if(!busy)document.body.classList.add("drag");}});
window.addEventListener("dragleave",()=>{enters=Math.max(0,enters-1);if(!enters)document.body.classList.remove("drag");});
window.addEventListener("dragover",e=>e.preventDefault());window.addEventListener("drop",e=>{e.preventDefault();enters=0;document.body.classList.remove("drag");upload(e.dataTransfer.files[0]);});
async function openDemo(restore) {
  busyState(true);
  try{let saved;try{saved=restore?JSON.parse(localStorage.getItem("takecut-session")):null;}catch{}
    if(saved?.job){try{await load(saved.job,saved.title,saved);return;}catch{}}
    await load("demo","中文口播练习");
  }catch(err){status(err.message);}finally{busyState(false);}
}
$("demo").onclick=()=>openDemo(false);
window.addEventListener("keydown",e=>{
  if(busy||!original||e.defaultPrevented||e.isComposing||e.altKey||e.target.closest?.("input,textarea,select,[contenteditable=true]"))return;
  const modifier=e.ctrlKey||e.metaKey;
  const buttons=modifier&&!e.shiftKey?{KeyB:"split",KeyZ:"undo"}:
    modifier?{}:e.shiftKey?{Backspace:"cut",Delete:"cut"}:
    {KeyI:"markIn",KeyO:"markOut",Escape:"clearMarks",Slash:"join"};
  const button=buttons[e.code];
  if(button){e.preventDefault();if(!e.repeat&&!$(button).hidden)$(button).click();return;}
  if(modifier||e.shiftKey)return;
  if(e.code==="Space"){e.preventDefault();if(e.repeat)return;if(player){stop();draw();}else $("play").click();}
  if(e.code==="ArrowLeft"||e.code==="ArrowRight"){
    e.preventDefault();stop();resumeAt=null;cursor=Math.min(total(),Math.max(0,cursor+(e.code==="ArrowLeft"?-.05:.05)));draw();
  }
});
openDemo(true);
