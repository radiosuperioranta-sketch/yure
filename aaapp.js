// Agrega esto al inicio de tu app.js
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Reemplaza toggleSystemPower y la lógica de micrófono
let audioActive = false;

async function toggleSystemPower() {
    audioActive = !audioActive;
    const btn = document.getElementById('btnPower');
    btn.textContent = audioActive ? '⚡ ON' : '⚡ OFF';
    btn.classList.toggle('on', audioActive);

    if (audioActive) {
        try {
            await invoke('start_audio_input');
            startMeterListener();
        } catch (err) {
            alert('❌ Error al acceder al audio: ' + err);
            audioActive = false;
            btn.textContent = '⚡ OFF';
            btn.classList.remove('on');
        }
    } else {
        await invoke('stop_audio_input');
        stopMeterListener();
    }
}

// Escucha los datos del backend Rust
let meterListener = null;
function startMeterListener() {
    meterListener = listen('audio_meters', (event) => {
        const data = event.payload;
        // Actualiza tus mini-meters con los datos reales del SO
        updateMiniMeter('m-in-l', data.input_l, 'pinL');
        updateMiniMeter('m-in-r', data.input_r, 'pinR');
        // Aquí puedes actualizar el resto de medidores cuando el DSP en Rust esté listo
    });
}

function stopMeterListener() {
    if (meterListener) meterListener.then(unlisten => unlisten());
}

// Elimina navigator.mediaDevices.getUserMedia y setSinkId de tu código actual
// El resto de tu UI (faders, bypass, EQ sliders) sigue funcionando igual