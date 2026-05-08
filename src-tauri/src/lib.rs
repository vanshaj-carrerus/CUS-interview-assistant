use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use vosk::{CompleteResult, DecodingState, Model, Recognizer};

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    },
};

#[derive(Clone, Serialize)]
struct TranscriptPayload {
    text: String,
    is_final: bool,
}

enum ControlMessage {
    Stop,
}

static CAPTURE_TX: OnceLock<Mutex<Option<Sender<ControlMessage>>>> = OnceLock::new();

fn emit_transcript(app: &AppHandle, text: String, is_final: bool) {
    let _ = app.emit("transcript-event", TranscriptPayload { text, is_final });
}

fn resolve_model_path(model_path: Option<String>) -> Result<String, String> {
    fn is_vosk_model_dir(path: &Path) -> bool {
        path.join("am").join("final.mdl").exists() && path.join("conf").join("model.conf").exists()
    }

    fn normalize_model_dir(path: PathBuf) -> Option<PathBuf> {
        if is_vosk_model_dir(&path) {
            return Some(path);
        }

        let entries = std::fs::read_dir(&path).ok()?;
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() && is_vosk_model_dir(&child) {
                return Some(child);
            }
        }
        None
    }

    if let Some(path) = model_path {
        let provided = PathBuf::from(&path);
        if !provided.exists() {
            return Err(format!("Configured Vosk model path does not exist: {path}"));
        }
        if let Some(normalized) = normalize_model_dir(provided) {
            return Ok(normalized.to_string_lossy().to_string());
        }
        return Err(format!(
            "Configured Vosk model path is not a valid model directory: {path}"
        ));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    // Useful for `tauri dev` where process cwd is usually `src-tauri`.
    candidates.push(PathBuf::from("models/vosk-model"));
    // Useful if cwd is repo root.
    candidates.push(PathBuf::from("src-tauri/models/vosk-model"));
    // Useful for packaged app where model may be copied beside executable.
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("models").join("vosk-model"));
        }
    }

    for candidate in &candidates {
        if candidate.exists() {
            if let Some(normalized) = normalize_model_dir(candidate.clone()) {
                return Ok(normalized.to_string_lossy().to_string());
            }
        }
    }

    let searched_paths = candidates
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<String>>()
        .join(", ");
    Err(format!(
        "Vosk model path is invalid. Put a model at one of: {searched_paths}"
    ))
}

fn recognize_chunk(recognizer: &Arc<Mutex<Recognizer>>, app: &AppHandle, mono_samples: Vec<i16>) {
    let Ok(mut recognizer) = recognizer.lock() else {
        return;
    };

    match recognizer.accept_waveform(&mono_samples) {
        Ok(DecodingState::Finalized) => {
            if let CompleteResult::Single(result) = recognizer.result() {
                let text = result.text.trim();
                if !text.is_empty() {
                    emit_transcript(app, text.to_string(), true);
                }
            }
        }
        Ok(DecodingState::Running) => {
            let text = recognizer.partial_result().partial.trim().to_string();
            if !text.is_empty() {
                emit_transcript(app, text, false);
            }
        }
        Ok(DecodingState::Failed) | Err(_) => {}
    }
}

fn build_loopback_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    recognizer: Arc<Mutex<Recognizer>>,
    app: AppHandle,
) -> Result<cpal::Stream, String> {
    let channels = usize::from(config.channels.max(1));
    let app_for_error = app.clone();
    let error_callback = move |err| {
        let message = format!("Audio capture error: {err}");
        eprintln!("{message}");
        emit_transcript(&app_for_error, message, true);
    };

    match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |data: &[f32], _| {
                    let mono_samples = data
                        .chunks(channels)
                        .map(|frame| {
                            let sum = frame.iter().copied().sum::<f32>();
                            let avg = sum / channels as f32;
                            (avg.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                        })
                        .collect::<Vec<i16>>();
                    recognize_chunk(&recognizer, &app, mono_samples);
                },
                error_callback,
                None,
            )
            .map_err(|err| format!("Failed to build f32 loopback stream: {err}")),
        SampleFormat::I16 => device
            .build_input_stream(
                config,
                move |data: &[i16], _| {
                    let mono_samples = data
                        .chunks(channels)
                        .map(|frame| {
                            let sum = frame.iter().copied().map(i32::from).sum::<i32>();
                            (sum / channels as i32) as i16
                        })
                        .collect::<Vec<i16>>();
                    recognize_chunk(&recognizer, &app, mono_samples);
                },
                error_callback,
                None,
            )
            .map_err(|err| format!("Failed to build i16 loopback stream: {err}")),
        SampleFormat::U16 => device
            .build_input_stream(
                config,
                move |data: &[u16], _| {
                    let mono_samples = data
                        .chunks(channels)
                        .map(|frame| {
                            let sum = frame
                                .iter()
                                .copied()
                                .map(|sample| i32::from(sample) - i32::from(u16::MAX / 2))
                                .sum::<i32>();
                            (sum / channels as i32) as i16
                        })
                        .collect::<Vec<i16>>();
                    recognize_chunk(&recognizer, &app, mono_samples);
                },
                error_callback,
                None,
            )
            .map_err(|err| format!("Failed to build u16 loopback stream: {err}")),
        other => Err(format!("Unsupported sample format: {other:?}")),
    }
}

#[tauri::command]
fn start_system_audio_transcription(app: AppHandle, model_path: Option<String>) -> Result<(), String> {
    let tx_store = CAPTURE_TX.get_or_init(|| Mutex::new(None));
    let mut tx_guard = tx_store
        .lock()
        .map_err(|_| "Failed to lock capture state".to_string())?;
    if tx_guard.is_some() {
        return Ok(());
    }

    let (control_tx, control_rx) = mpsc::channel::<ControlMessage>();
    *tx_guard = Some(control_tx);
    drop(tx_guard);

    let resolved_model_path = resolve_model_path(model_path)?;
    let worker_app = app.clone();

    std::thread::spawn(move || {
        let Some(model) = Model::new(&resolved_model_path) else {
            emit_transcript(
                &worker_app,
                format!("Failed to load Vosk model at: {resolved_model_path}"),
                true,
            );
            if let Ok(mut tx) = CAPTURE_TX.get_or_init(|| Mutex::new(None)).lock() {
                *tx = None;
            }
            return;
        };

        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            emit_transcript(&worker_app, "No output audio device found.".to_string(), true);
            if let Ok(mut tx) = CAPTURE_TX.get_or_init(|| Mutex::new(None)).lock() {
                *tx = None;
            }
            return;
        };

        let Ok(output_config) = device.default_output_config() else {
            emit_transcript(&worker_app, "Unable to read output device config.".to_string(), true);
            if let Ok(mut tx) = CAPTURE_TX.get_or_init(|| Mutex::new(None)).lock() {
                *tx = None;
            }
            return;
        };

        let sample_rate = output_config.sample_rate().0 as f32;
        let Some(recognizer) = Recognizer::new(&model, sample_rate) else {
            emit_transcript(&worker_app, "Failed to create Vosk recognizer.".to_string(), true);
            if let Ok(mut tx) = CAPTURE_TX.get_or_init(|| Mutex::new(None)).lock() {
                *tx = None;
            }
            return;
        };

        let recognizer = Arc::new(Mutex::new(recognizer));
        let stream_config = output_config.config();
        let sample_format = output_config.sample_format();
        let stream = match build_loopback_stream(
            &device,
            &stream_config,
            sample_format,
            recognizer,
            worker_app.clone(),
        ) {
            Ok(stream) => stream,
            Err(err) => {
                emit_transcript(&worker_app, err, true);
                if let Ok(mut tx) = CAPTURE_TX.get_or_init(|| Mutex::new(None)).lock() {
                    *tx = None;
                }
                return;
            }
        };

        if let Err(err) = stream.play() {
            emit_transcript(&worker_app, format!("Failed to start stream: {err}"), true);
            if let Ok(mut tx) = CAPTURE_TX.get_or_init(|| Mutex::new(None)).lock() {
                *tx = None;
            }
            return;
        }

        loop {
            match control_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(ControlMessage::Stop) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        drop(stream);
        if let Ok(mut tx) = CAPTURE_TX.get_or_init(|| Mutex::new(None)).lock() {
            *tx = None;
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_system_audio_transcription() -> Result<(), String> {
    let tx_store = CAPTURE_TX.get_or_init(|| Mutex::new(None));
    let mut tx_guard = tx_store
        .lock()
        .map_err(|_| "Failed to lock capture state".to_string())?;
    if let Some(tx) = tx_guard.take() {
        let _ = tx.send(ControlMessage::Stop);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;

            // Hide the window from screen capture (display mirroring, OBS, etc.).
            window.set_content_protected(true)?;

            // On Windows, also hide from the taskbar and Alt-Tab switcher
            // by adding the WS_EX_TOOLWINDOW extended style to the HWND.
            #[cfg(target_os = "windows")]
            {
                let hwnd_raw = window.hwnd()?.0 as isize;
                unsafe {
                    let hwnd = HWND(hwnd_raw as _);
                    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    SetWindowLongPtrW(
                        hwnd,
                        GWL_EXSTYLE,
                        ex_style | WS_EX_TOOLWINDOW.0 as isize,
                    );
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_system_audio_transcription,
            stop_system_audio_transcription
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
