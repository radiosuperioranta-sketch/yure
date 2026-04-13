document.addEventListener('DOMContentLoaded', () => {
    // AudioWorklet: True Peak & Phase Correlation
    const WORKLET_CODE = `
        class TruePeakProcessor extends AudioWorkletProcessor {
            process(inputs, outputs) {
                const L = inputs[0][0] || new Float32Array(128);
                const R = inputs[0][1] || new Float32Array(128);
                let maxL = 0, maxR = 0, sumL=0, sumR=0, sumLR=0;
                for(let i=0; i<L.length-1; i++) {
                    const a=(L[i+1]-L[i])/4, b=(R[i+1]-R[i])/4, c=(L[i+1]-L[i]), d=(R[i+1]-R[i]);
                    maxL = Math.max(maxL, Math.abs(L[i]), Math.abs(L[i]+a*1+c*0.5), Math.abs(L[i]+a*2+c));
                    maxR = Math.max(maxR, Math.abs(R[i]), Math.abs(R[i]+b*1+d*0.5), Math.abs(R[i]+b*2+d));
                    sumL+=L[i]**2; sumR+=R[i]**2; sumLR+=L[i]*R[i];
                }
                const corr=(sumL>1e-10 && sumR>1e-10) ? sumLR/Math.sqrt(sumL*sumR) : 0;
                this.port.postMessage({ tpL: 20*Math.log10(maxL||1e-10), tpR: 20*Math.log10(maxR||1e-10), corr });
                return true;
            }
        }
        registerProcessor('truepeak-processor', TruePeakProcessor);
    `;

    let workletURL, audioCtx, inputStream = null, truePeakNode;

    async function loadWorklet() {
        if(!audioCtx) return;
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        workletURL = URL.createObjectURL(blob);
        await audioCtx.audioWorklet.addModule(workletURL);
    }

    const MODULES = [
        { id: 'eq', title: 'Parametric EQ', sub: 'Pre-AGC', meters: ['L','R'], type: 'meter', hasEQ: true },
        { id: 'input', title: 'Input', meters: ['L','R'], type: 'meter' },
        { id: 'agc', title: 'AGC', sub: 'Gate / Comp', meters: ['B','M','L','R'], type: 'comp', params: { thr: -20, ratio: 4, atk: 0.02, rel: 0.15, mkup: 6 } },
        { id: 'stereo', title: 'Stereo Width', meters: ['M/S'], type: 'width' },
        { id: 'gr', title: 'Gain Reduction', sub: 'Multi Gate', meters: ['1','2','3','4','5'], type: 'meter', narrow: true },
        { id: 'limiter', title: 'Limiter', meters: ['L','R'], type: 'comp', params: { thr: -3, ratio: 20, atk: 0.001, rel: 0.05, mkup: 1 } },
        { id: 'loudlevel', title: 'Loudness Level', meters: ['dB','LU'], type: 'lufs', tall: true },
        { id: 'output', title: 'Output', meters: ['L','R'], type: 'meter' }
    ];

    const stages = {};
    const channelStates = new Map();
    const tooltip = document.getElementById('tooltip');
    const presets = JSON.parse(localStorage.getItem('broadcastProPresetsV4') || '{}');
    let activePreset = 'default';
    const peakState = {};
    const SEGMENTS = 50;
    let peakDecayRate = 0.012, currentSmoothing = 0.35, lufsTarget = -23;
    let masterInMute = false, masterOutMute = false, systemOn = false;
    let masterInGain, masterOutGain, masterPowerGain, sourceNode;
    let masterInAnalyserL, masterInAnalyserR, masterOutAnalyserL, masterOutAnalyserR;
    let lufsEngine;

    class LUFSEngine {
        constructor(ctx) {
            this.ctx=ctx; this.sr=ctx.sampleRate; this.frameSize=1024;
            this.momentaryLen=Math.ceil(this.sr*0.4/this.frameSize); this.shortTermLen=Math.ceil(this.sr*3.0/this.frameSize);
            this.energyBuf=new Float32Array(this.shortTermLen); this.idx=0; this.integratedSum=0; this.integratedCount=0; this.integrated=-70;
        }
        calculate(dataL, dataR) {
            let p=0; for(let i=0;i<dataL.length;i++) p+=dataL[i]**2+dataR[i]**2; p/=dataL.length;
            this.energyBuf[this.idx%this.energyBuf.length]=p; this.idx++;
            const avg=(c)=>{ let s=0, st=Math.max(0,this.idx-c); for(let i=st;i<this.idx;i++) s+=this.energyBuf[i%this.energyBuf.length]; return s/c; };
            let mP=avg(Math.min(this.momentaryLen,this.idx)), sP=avg(Math.min(this.shortTermLen,this.idx));
            const toLU=(pw)=>pw>1e-20?-0.691+10*Math.log10(pw):-70;
            let mLU=toLU(mP), sLU=toLU(sP);
            if(mLU>-70){this.integratedSum+=mP; this.integratedCount++;}
            let iLU=-70; if(this.integratedCount>0) iLU=toLU(this.integratedSum/this.integratedCount);
            this.integrated=iLU; return {m:mLU, s:sLU, i:iLU};
        }
        reset(){ this.energyBuf.fill(0); this.idx=0; this.integratedSum=0; this.integratedCount=0; this.integrated=-70; }
    }

    async function toggleSystemPower() {
        systemOn = !systemOn;
        const btn = document.getElementById('btnPower');
        btn.textContent = systemOn ? '⚡ ON' : '⚡ OFF';
        btn.classList.toggle('on', systemOn);
        if (!audioCtx) {
            audioCtx = new AudioContext({ sampleRate: 48000 });
            await loadWorklet();
            initAudioChain();
        }
        if (systemOn) { 
            await audioCtx.resume(); 
            masterPowerGain?.gain.setTargetAtTime(1, audioCtx.currentTime, 0.05); 
        } else { 
            masterPowerGain?.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05); 
            setTimeout(() => audioCtx.suspend(), 100); 
        }
        localStorage.setItem('broadcastSystemState', JSON.stringify({ on: systemOn }));
    }

    function initAudioChain() {
        if (!audioCtx) return;
        lufsEngine = new LUFSEngine(audioCtx);
        sourceNode = audioCtx.createGain(); sourceNode.gain.value = 0;
        
        masterInGain = audioCtx.createGain(); masterInGain.gain.value = 1;
        masterInAnalyserL = audioCtx.createAnalyser(); masterInAnalyserR = audioCtx.createAnalyser();
        const inMeterSplitter = audioCtx.createChannelSplitter(2);
        sourceNode.connect(masterInGain); masterInGain.connect(inMeterSplitter);
        inMeterSplitter.connect(masterInAnalyserL, 0, 0); inMeterSplitter.connect(masterInAnalyserR, 1, 0);

        truePeakNode = new AudioWorkletNode(audioCtx, 'truepeak-processor');
        truePeakNode.port.onmessage = e => { stages._tp = e.data; };

        let chainL = masterInGain, chainR = masterInGain;
        const merger = audioCtx.createChannelMerger(2);

        MODULES.forEach(mod => {
            stages[mod.id] = { bypassed: false, channels: [], comp: null, eqNodes: [] };
            
            mod.meters.forEach((m, i) => {
                const isR = (mod.meters.length===4 && (i===1||i===3)) || (mod.meters.length===2 && i===1);
                const prev = isR ? chainR : chainL;
                const key = `${mod.id}_${i}`;

                const aIn = audioCtx.createAnalyser(); aIn.fftSize=256; aIn.smoothingTimeConstant=currentSmoothing;
                const aOut = audioCtx.createAnalyser(); aOut.fftSize=256; aOut.smoothingTimeConstant=currentSmoothing;
                const wet = audioCtx.createGain(); wet.gain.value=1;
                const dry = audioCtx.createGain(); dry.gain.value=0;
                const mute = audioCtx.createGain(); mute.gain.value=1;

                stages[mod.id].channels.push({ wet, dry, mute, aIn, aOut });
                channelStates.set(key, { mute, gainNode: wet, solo: false, mute: false });

                // Wet Path
                prev.connect(aIn);
                if(mod.type==='comp' && mod.params) {
                    const comp = audioCtx.createDynamicsCompressor();
                    comp.threshold.value=mod.params.thr; comp.knee.value=6; comp.ratio.value=mod.params.ratio;
                    comp.attack.value=mod.params.atk; comp.release.value=mod.params.rel;
                    const mkup = audioCtx.createGain(); mkup.gain.value=10**(mod.params.mkup/20);
                    stages[mod.id].comp = comp;
                    aIn.connect(comp); comp.connect(aOut); aOut.connect(mkup); mkup.connect(wet);
                } else {
                    aIn.connect(aOut); aOut.connect(wet);
                }

                // Dry Path (Bypass)
                prev.connect(dry);

                // Merge
                wet.connect(mute); dry.connect(mute);
                if(isR) chainR = mute; else chainL = mute;
            });
        });

        masterOutAnalyserL = audioCtx.createAnalyser(); masterOutAnalyserR = audioCtx.createAnalyser();
        masterOutGain = audioCtx.createGain(); masterOutGain.gain.value = 1;
        masterPowerGain = audioCtx.createGain(); masterPowerGain.gain.value = systemOn ? 1 : 0;

        chainL.connect(masterOutAnalyserL, 0, 0); chainR.connect(masterOutAnalyserR, 0, 1);
        masterOutAnalyserL.connect(truePeakNode); masterOutAnalyserR.connect(truePeakNode);
        
        const outSplit = audioCtx.createChannelSplitter(2);
        truePeakNode.connect(outSplit); outSplit.connect(masterOutGain, 0, 0); outSplit.connect(masterOutGain, 1, 1);
        masterOutGain.connect(masterPowerGain); masterPowerGain.connect(merger); merger.connect(audioCtx.destination);

        applyDeviceSettings();
        requestAnimationFrame(renderLoop);
    }

    async function switchAudioInput(deviceId) {
        if(!audioCtx) return;
        try {
            if(inputStream) inputStream.getTracks().forEach(t => t.stop());
            const stream = await navigator.mediaDevices.getUserMedia(deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true });
            inputStream = stream;
            const newSrc = audioCtx.createMediaStreamSource(stream);
            newSrc.connect(masterInGain);
            if(deviceId) localStorage.setItem('lastInputDev', deviceId);
        } catch(e) { console.error('Error entrada:', e); }
    }

    async function switchAudioOutput(deviceId) { 
        if(!audioCtx || !audioCtx.setSinkId) return; 
        try { await audioCtx.setSinkId(deviceId || ''); } catch(e) {} 
    }

    function applyDeviceSettings() {
        const inDev = localStorage.getItem('lastInputDev') || document.getElementById('setAudioInput')?.value || '';
        const outDev = JSON.parse(localStorage.getItem('broadcastSettings') || '{}').outputDev || document.getElementById('setAudioOutput')?.value || '';
        if(inDev) switchAudioInput(inDev);
        if(outDev) switchAudioOutput(outDev);
    }

    function toggleBypass(modId) {
        const mod = stages[modId]; if(!mod) return;
        mod.bypassed = !mod.bypassed;
        const t = audioCtx.currentTime;
        const valWet = mod.bypassed ? 0 : 1;
        const valDry = mod.bypassed ? 1 : 0;
        mod.channels.forEach(ch => {
            ch.wet.gain.setTargetAtTime(valWet, t, 0.005);
            ch.dry.gain.setTargetAtTime(valDry, t, 0.005);
        });
        document.querySelector(`.btn-ab[data-mod="${modId}"]`)?.classList.toggle('active', mod.bypassed);
    }

    function buildUI() {
        const grid=document.getElementById('grid'); grid.innerHTML='';
        MODULES.forEach(mod=>{
            const el=document.createElement('div'); el.className='mod';
            let html=`<div class="mod-title">${mod.title}</div>`;
            if(mod.sub) html+=`<div class="mod-sub">${mod.sub}</div>`;
            if(mod.id==='limiter' || mod.id==='output') html+=`<div class="truepeak-indicator" id="tp-${mod.id}"></div>`;
            
            html+=`<div class="meter-row">`;
            mod.meters.forEach((m,i)=>{
                const h=mod.tall?'tall':(mod.narrow?'narrow':'');
                html+=`<div class="meter-wrap"><div class="meter-box ${h}" data-mod="${mod.id}" data-ch="${i}" data-id="${mod.id}_${i}"><div class="leds">${'<div class="led"></div>'.repeat(50)}</div><div class="peak-line"></div></div><div class="meter-label">${m}</div></div>`;
            });
            html+=`</div><button class="btn-ab" data-mod="${mod.id}">A|B</button><div class="controls-row">`;
            
            mod.meters.forEach((m,i)=>{
                html+=`<div class="ctrl"><div class="sm-btns"><button class="btn-s" data-mod="${mod.id}" data-ch="${i}">S</button><button class="btn-m" data-mod="${mod.id}" data-ch="${i}">M</button></div><div class="fader-track" data-mod="${mod.id}" data-ch="${i}" data-val="0"><div class="fader-fill" style="height:50%"></div><div class="fader-thumb" style="bottom:50%"></div></div><div class="ctrl-val">0.0 dB</div></div>`;
            });
            html+=`</div>`;
            
            if(mod.hasEQ) {
                html+=`<div class="controls-row" style="margin-top:3px; border-top:1px solid var(--border); padding-top:3px; width:100%">`;
                ['HPF','LPF','PEQ1','PEQ2'].forEach((b,idx)=>{
                    html+=`<div class="ctrl"><label>${b}</label><input type="range" class="slider" min="20" max="20000" value="${idx<2?[80,18000][idx]:[150,8000][idx-2]}" data-mod="${mod.id}" data-band="${b}" data-param="freq"><input type="range" class="slider" min="0.1" max="10" step="0.1" value="1" data-mod="${mod.id}" data-band="${b}" data-param="q"><input type="range" class="slider" min="-12" max="12" value="0" data-mod="${mod.id}" data-band="${b}" data-param="gain"></div>`;
                });
                html+=`</div>`;
            }
            if(mod.type==='width') html+=`<div class="ctrl" style="margin-top:4px"><label>Width</label><input type="range" class="slider" min="0" max="2" step="0.01" value="1" data-mod="${mod.id}" data-param="width"><div class="ctrl-val" id="width-val">100%</div><div class="phase-meter"><div class="phase-fill" id="phase-fill"></div></div></div>`;
            if(mod.type==='lufs') html+=`<div class="lufs-panel"><div class="lufs-box"><div class="lufs-label">Mom</div><div class="lufs-val" id="lufs-m">-70.0</div></div><div class="lufs-box"><div class="lufs-label">ST</div><div class="lufs-val" id="lufs-s">-70.0</div></div><div class="lufs-box"><div class="lufs-label">Int</div><div class="lufs-val integrated" id="lufs-i">-70.0</div></div></div>`;
            
            el.innerHTML=html; grid.appendChild(el);
        });
        setupInteractions(); loadSettings();
        if(JSON.parse(localStorage.getItem('broadcastSystemState') || '{}').on) { systemOn = true; toggleSystemPower(); }
    }

    async function refreshDeviceLists() {
        const iS = document.getElementById('setAudioInput');
        const oS = document.getElementById('setAudioOutput');
        iS.innerHTML = '<option value="">Por defecto</option>'; oS.innerHTML = '<option value="">Por defecto</option>';
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
            const devices = await navigator.mediaDevices.enumerateDevices();
            devices.forEach(d => {
                const o = document.createElement('option'); o.value = d.deviceId; o.text = d.label || `${d.kind.slice(5)} (${d.deviceId.slice(0,8)})`;
                if(d.kind==='audioinput') iS.appendChild(o);
                if(d.kind==='audiooutput') oS.appendChild(o);
            });
        } catch(e) {}
    }

    function setupInteractions() {
        document.querySelectorAll('.meter-box').forEach(b=>{
            b.addEventListener('mousemove',e=>{
                const db=parseFloat(b.dataset.db||'-60'), gr=parseFloat(b.dataset.gr||'0');
                tooltip.textContent=`${b.dataset.id.toUpperCase()} → ${db.toFixed(1)} dBFS`+(gr>0.1?` | GR:-${gr.toFixed(1)}`:'');
                tooltip.style.left=e.clientX+12+'px'; tooltip.style.top=e.clientY-28+'px'; tooltip.classList.add('show');
            });
            b.addEventListener('mouseleave',()=>tooltip.classList.remove('show'));
        });
        document.querySelectorAll('.fader-track').forEach(t=>{
            let drag=false; const upd=y=>{
                const r=t.getBoundingClientRect(), p=Math.max(0,Math.min(1,1-(y-r.top)/r.height)), db=(p*24-12).toFixed(1);
                t.dataset.val=db; t.querySelector('.fader-thumb').style.bottom=`${p*100}%`; t.querySelector('.fader-fill').style.height=`${p*100}%`;
                t.nextElementSibling.querySelector('.ctrl-val').textContent=`${db} dB`;
                const st=channelStates.get(`${t.dataset.mod}_${t.dataset.ch}`);
                if(st) st.gainNode.gain.setTargetAtTime(10**(db/20), audioCtx.currentTime, 0.01);
            };
            t.querySelector('.fader-thumb').addEventListener('mousedown',e=>{drag=true;e.preventDefault();});
            document.addEventListener('mousemove',e=>{if(drag)upd(e.clientY);});
            document.addEventListener('mouseup',()=>drag=false);
            t.addEventListener('click',e=>upd(e.clientY));
        });
        document.querySelectorAll('.slider').forEach(s=>{
            s.addEventListener('input',()=>{
                const m=stages[s.dataset.mod]; if(!m) return; const v=parseFloat(s.value);
                if(s.dataset.param==='freq'||s.dataset.param==='q'||s.dataset.param==='gain') {}
                else if(s.dataset.param==='width') document.getElementById('width-val').textContent=`${(v*100).toFixed(0)}%`;
                else if(s.dataset.param==='thr') m.comp?.threshold.setTargetAtTime(v,audioCtx.currentTime,0.02);
                else if(s.dataset.param==='ratio') m.comp?.ratio.setTargetAtTime(v,audioCtx.currentTime,0.02);
                else if(s.dataset.param==='atk') m.comp?.attack.setTargetAtTime(v,audioCtx.currentTime,0.02);
                else if(s.dataset.param==='rel') m.comp?.release.setTargetAtTime(v,audioCtx.currentTime,0.02);
                else if(s.dataset.param==='mkup') m.makeupGain?.setTargetAtTime(10**(v/20),audioCtx.currentTime,0.02);
            });
        });
        document.querySelectorAll('.btn-s, .btn-m').forEach(b=>{
            b.addEventListener('click',()=>{
                const k=`${b.dataset.mod}_${b.dataset.ch}`, st=channelStates.get(k); if(!st) return;
                if(b.classList.contains('btn-s')){st.solo=!st.solo; b.classList.toggle('active',st.solo);}
                else{st.mute=!st.mute; b.classList.toggle('active',st.mute);}
                updateRouting();
            });
        });
        document.querySelectorAll('.btn-ab').forEach(b=>{ b.addEventListener('click',()=>toggleBypass(b.dataset.mod)); });
        
        const inGain=document.getElementById('master-in-gain'), outGain=document.getElementById('master-out-gain');
        inGain.addEventListener('input',()=>{ const db=parseFloat(inGain.value); document.getElementById('val-in-gain').textContent=`${db.toFixed(1)} dB`; masterInGain?.gain.setTargetAtTime(10**(db/20),audioCtx.currentTime,0.01); });
        outGain.addEventListener('input',()=>{ const db=parseFloat(outGain.value); document.getElementById('val-out-gain').textContent=`${db.toFixed(1)} dB`; masterOutGain?.gain.setTargetAtTime(10**(db/20),audioCtx.currentTime,0.01); });
        document.getElementById('btn-mute-in').addEventListener('click',e=>{ masterInMute=!masterInMute; e.target.classList.toggle('active',masterInMute); masterInGain?.gain.setTargetAtTime(masterInMute?0.0001:10**(parseFloat(inGain.value)/20),audioCtx.currentTime,0.01); });
        document.getElementById('btn-mute-out').addEventListener('click',e=>{ masterOutMute=!masterOutMute; e.target.classList.toggle('active',masterOutMute); masterOutGain?.gain.setTargetAtTime(masterOutMute?0.0001:10**(parseFloat(outGain.value)/20),audioCtx.currentTime,0.01); });
        
        document.getElementById('btnPower').onclick = toggleSystemPower;
        const modal=document.getElementById('settingsModal');
        document.getElementById('btnSettings').onclick=()=>{modal.classList.add('open'); refreshDeviceLists();};
        document.getElementById('btnCloseModal').onclick=()=>modal.classList.remove('open');
        modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.remove('open');});
        document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('open'))modal.classList.remove('open');});
        document.getElementById('setAudioInput').onchange = e => switchAudioInput(e.target.value);
        document.getElementById('setAudioOutput').onchange = e => switchAudioOutput(e.target.value);
        document.getElementById('btnApplySettings').onclick=()=>{applySettings();modal.classList.remove('open');};
        document.getElementById('btnResetPeaks').onclick=()=>{for(let k in peakState) peakState[k]=0;};
    }

    function updateRouting(){ let anySolo=false; for(let s of channelStates.values()) if(s.solo){anySolo=true;break;} for(let [k,s] of channelStates.entries()){let t=1; if(s.mute)t=0.0001; else if(anySolo&&!s.solo)t=0.0001; s.mute.gain.setTargetAtTime(t,audioCtx.currentTime,0.02);} }

    let lufsUpdateTimer=0;
    function updateMiniMeter(id, db, peakKey){
        const el=document.getElementById(id); if(!el) return;
        const pct=Math.max(0, Math.min(1, (db+60)/60));
        let fill=el.querySelector('.fill'); if(!fill){fill=document.createElement('div'); fill.className='fill'; el.appendChild(fill);}
        fill.style.height=`${pct*100}%`; fill.style.background = pct<0.65?'#00e676':pct<0.85?'#ffd600':'#ff1744';
        if(!peakState[peakKey]) peakState[peakKey]=0;
        if(pct>peakState[peakKey]) peakState[peakKey]=pct; else peakState[peakKey]-=peakDecayRate;
        if(peakState[peakKey]<0) peakState[peakKey]=0;
    }

    function renderLoop(time){
        const dt=(time-(renderLoop.last||time))/16.67; renderLoop.last=time;
        MODULES.forEach(mod=>{
            mod.meters.forEach((m,i)=>{
                const st=stages[mod.id]; if(!st) return;
                let dbIn=-60, dbOut=-60, gr=0;
                if(st.channels[i]){
                    const bIn=new Float32Array(st.channels[i].aIn.fftSize); st.channels[i].aIn.getFloatTimeDomainData(bIn);
                    const rIn=Math.sqrt(bIn.reduce((a,b)=>a+b*b,0)/bIn.length); dbIn=rIn>0?20*Math.log10(rIn):-60;
                    const bOut=new Float32Array(st.channels[i].aOut.fftSize); st.channels[i].aOut.getFloatTimeDomainData(bOut);
                    const rOut=Math.sqrt(bOut.reduce((a,b)=>a+b*b,0)/bOut.length); dbOut=rOut>0?20*Math.log10(rOut):-60;
                    gr=Math.max(0, dbIn-dbOut);
                } else if(mod.id==='output'){
                    const b=new Float32Array(masterOutAnalyserL.fftSize); masterOutAnalyserL.getFloatTimeDomainData(b);
                    const r=Math.sqrt(b.reduce((a,b)=>a+b*b,0)/b.length); dbOut=r>0?20*Math.log10(r):-60; dbIn=dbOut; gr=0;
                }
                const db=Math.max(-60,Math.min(0,(mod.id==='input'||mod.id==='output')?dbOut:dbIn));
                const pct=(db+60)/60;
                const box=document.querySelector(`[data-id="${mod.id}_${i}"]`); if(!box) return;
                box.dataset.db=db; box.dataset.gr=gr;
                const active=Math.round(pct*SEGMENTS);
                const leds=box.querySelectorAll('.led');
                for(let s=0;s<SEGMENTS;s++) leds[s].className=`led ${mod.meters.length===4&&(i===0||i===1)?(s<active?'b':'bd'):(s<active?(s<33?'g':s<42?'y':'r'):(s<33?'gd':s<42?'yd':'rd'))}`;
                const key=`${mod.id}_${i}`; if(!peakState[key]) peakState[key]=0;
                if(pct>peakState[key]) peakState[key]=pct; else peakState[key]-=peakDecayRate*dt;
                if(peakState[key]<0) peakState[key]=0;
                box.querySelector('.peak-line').style.top=`${(1-peakState[key])*100}%`;
            });
        });
        if(masterInAnalyserL && systemOn){
            const dL=new Float32Array(masterInAnalyserL.fftSize), dR=new Float32Array(masterInAnalyserR.fftSize);
            masterInAnalyserL.getFloatTimeDomainData(dL); masterInAnalyserR.getFloatTimeDomainData(dR);
            updateMiniMeter('m-in-l', Math.sqrt(dL.reduce((a,b)=>a+b*b,0)/dL.length)>0?20*Math.log10(Math.sqrt(dL.reduce((a,b)=>a+b*b,0)/dL.length)):-60, 'pinL');
            updateMiniMeter('m-in-r', Math.sqrt(dR.reduce((a,b)=>a+b*b,0)/dR.length)>0?20*Math.log10(Math.sqrt(dR.reduce((a,b)=>a+b*b,0)/dR.length)):-60, 'pinR');
        }
        if(masterOutAnalyserL && systemOn){
            const dL=new Float32Array(masterOutAnalyserL.fftSize), dR=new Float32Array(masterOutAnalyserR.fftSize);
            masterOutAnalyserL.getFloatTimeDomainData(dL); masterOutAnalyserR.getFloatTimeDomainData(dR);
            updateMiniMeter('m-out-l', Math.sqrt(dL.reduce((a,b)=>a+b*b,0)/dL.length)>0?20*Math.log10(Math.sqrt(dL.reduce((a,b)=>a+b*b,0)/dL.length)):-60, 'poutL');
            updateMiniMeter('m-out-r', Math.sqrt(dR.reduce((a,b)=>a+b*b,0)/dR.length)>0?20*Math.log10(Math.sqrt(dR.reduce((a,b)=>a+b*b,0)/dR.length)):-60, 'poutR');
        }
        if(stages._tp && systemOn) {
            const tp = stages._tp;
            ['limiter','output'].forEach(id=>{ const el=document.getElementById(`tp-${id}`); if(el) el.classList.toggle('clip', Math.max(tp.tpL, tp.tpR) > -0.5); });
            const fill=document.getElementById('phase-fill');
            if(fill) { fill.style.width=`${((tp.corr+1)/2)*100}%`; fill.style.background=tp.corr>0.5?'#00e676':tp.corr>0.2?'#ffd600':'#ff1744'; }
        }
        if(lufsUpdateTimer++%2===0 && lufsEngine && systemOn){
            const dL=new Float32Array(masterOutAnalyserL.fftSize), dR=new Float32Array(masterOutAnalyserR.fftSize);
            masterOutAnalyserL.getFloatTimeDomainData(dL); masterOutAnalyserR.getFloatTimeDomainData(dR);
            const lufs=lufsEngine.calculate(dL,dR);
            document.getElementById('lufs-m').textContent=lufs.m.toFixed(1);
            document.getElementById('lufs-s').textContent=lufs.s.toFixed(1);
            const iEl=document.getElementById('lufs-i'); iEl.textContent=lufs.i.toFixed(1);
            iEl.style.color=lufs.i>lufsTarget?'#ff1744':'#00e676';
        }
        requestAnimationFrame(renderLoop);
    }

    function loadSettings() {
        const s = JSON.parse(localStorage.getItem('broadcastSettings') || '{}');
        if (s.theme) document.getElementById('setTheme').value = s.theme;
        if (s.speed) document.getElementById('setMeterSpeed').value = s.speed;
        if (s.decay) document.getElementById('setPeakDecay').value = s.decay;
        if (s.target) document.getElementById('setLufsTarget').value = s.target;
        document.documentElement.dataset.theme = document.getElementById('setTheme').value;
        currentSmoothing = parseFloat(document.getElementById('setMeterSpeed').value) || 0.35;
        peakDecayRate = parseFloat(document.getElementById('setPeakDecay').value) || 0.012;
        lufsTarget = parseFloat(document.getElementById('setLufsTarget').value) || -23;
    }

    function applySettings() {
        document.documentElement.dataset.theme = document.getElementById('setTheme').value;
        currentSmoothing = parseFloat(document.getElementById('setMeterSpeed').value);
        peakDecayRate = parseFloat(document.getElementById('setPeakDecay').value);
        lufsTarget = parseFloat(document.getElementById('setLufsTarget').value);

        if (audioCtx) {
            MODULES.forEach(mod => {
                const st = stages[mod.id]; if(!st) return;
                st.channels.forEach(ch => { ch.aIn.smoothingTimeConstant=currentSmoothing; ch.aOut.smoothingTimeConstant=currentSmoothing; });
            });
        }
        localStorage.setItem('broadcastSettings', JSON.stringify({
            theme: document.getElementById('setTheme').value, speed: document.getElementById('setMeterSpeed').value,
            decay: document.getElementById('setPeakDecay').value, target: document.getElementById('setLufsTarget').value,
            outputDev: document.getElementById('setAudioOutput').value
        }));
        localStorage.setItem('lastInputDev', document.getElementById('setAudioInput').value);
        switchAudioInput(document.getElementById('setAudioInput').value);
        switchAudioOutput(document.getElementById('setAudioOutput').value);
    }

    function savePreset(){ const p={}; document.querySelectorAll('.fader-track, .slider').forEach(el=>{p[`${el.dataset.mod||''}_${el.dataset.ch||el.dataset.param||el.dataset.band}`]=parseFloat(el.dataset.val||el.value);}); presets[activePreset]=p; localStorage.setItem('broadcastProPresetsV4',JSON.stringify(presets)); btnFeedback('btnSave'); }
    function loadPreset(){ if(!presets[activePreset]) return alert('⚠️ Sin preset'); Object.entries(presets[activePreset]).forEach(([k,v])=>{const[m,s]=k.split('_'); const f=document.querySelector(`.fader-track[data-mod="${m}"][data-ch="${s}"]`); if(f){f.dataset.val=v; const p=(v+12)/24; f.querySelector('.fader-thumb').style.bottom=`${p*100}%`; f.querySelector('.fader-fill').style.height=`${p*100}%`; f.nextElementSibling.querySelector('.ctrl-val').textContent=`${v.toFixed(1)} dB`; const st=channelStates.get(`${m}_${s}`); if(st) st.gainNode.gain.setTargetAtTime(10**(v/20),audioCtx.currentTime,0.02); return;} const sl=document.querySelector(`.slider[data-mod="${m}"][data-param="${s}"]`); if(sl){sl.value=v; sl.dispatchEvent(new Event('input'));}}); btnFeedback('btnLoad'); }
    function btnFeedback(id){ const b=document.getElementById(id); if(!b) return; b.style.background='#2a4a60'; b.style.transform='scale(0.95)'; setTimeout(()=>{b.style.background=''; b.style.transform='';},200); }

    document.getElementById('btnSave').onclick=savePreset; document.getElementById('btnLoad').onclick=loadPreset; buildUI();
});