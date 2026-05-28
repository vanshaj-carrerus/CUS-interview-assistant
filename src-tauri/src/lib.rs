use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    },
};

const WHISPER_SAMPLE_RATE: u32 = 16_000;
const FRAME_MS: u32 = 40;
/// End-of-phrase silence — long enough for natural interview pauses without splitting one question.
const SILENCE_END_SECS: f64 = 1.2;
/// Emit live partial transcripts while speech is still active.
const PARTIAL_INTERVAL_SECS: f64 = 0.25;
const RMS_SILENCE_THRESHOLD: f32 = 0.006;
const MIN_UTTERANCE_SECS: f64 = 0.2;
/// Force a final chunk if someone speaks continuously without a long pause.
const MAX_UTTERANCE_SECS: f64 = 45.0;
const INFERENCE_RETRIES: u32 = 2;
const BUNDLED_WHISPER_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/models/whisper");
const PREFERRED_MODELS: &[&str] = &["ggml-base.en.bin", "ggml-tiny.en.bin"];
/// Real GGML Whisper models are tens of MB; LFS pointer stubs are ~130 bytes.
const MIN_WHISPER_MODEL_BYTES: u64 = 1_000_000;

#[derive(Clone, Serialize)]
struct SttErrorPayload {
    message: String,
}

#[derive(Clone, Serialize)]
struct SttListeningPayload {
    active: bool,
}

enum ControlMessage {
    Stop,
}

enum InferenceMessage {
    Partial(Vec<f32>, u64),
    Final(Vec<f32>),
    Stop,
}

enum VadEvent {
    None,
    SpeechStarted,
    SpeechEnded,
    Partial(Vec<f32>, u64),
    Final(Vec<f32>),
}

pub struct AppState {
    whisper: Mutex<Option<Arc<WhisperContext>>>,
    listen_control: Mutex<Option<Sender<ControlMessage>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            whisper: Mutex::new(None),
            listen_control: Mutex::new(None),
        }
    }
}

fn emit_stt_result(app: &AppHandle, text: String) {
    let _ = app.emit("stt-result", text);
}

fn emit_stt_partial(app: &AppHandle, text: String) {
    let _ = app.emit("stt-partial", text);
}

fn emit_stt_listening(app: &AppHandle, active: bool) {
    let _ = app.emit(
        "stt-listening",
        SttListeningPayload { active },
    );
}

fn emit_stt_error(app: &AppHandle, message: String) {
    let _ = app.emit(
        "stt-error",
        SttErrorPayload {
            message: message.clone(),
        },
    );
    eprintln!("[stt] {message}");
}

#[tauri::command]
fn get_api_keys() -> HashMap<String, String> {
    HashMap::new()
}

fn normalize_path(path: PathBuf) -> String {
    let mut text = path.to_string_lossy().into_owned();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        text = stripped.to_string();
    }
    text
}

fn is_whisper_model_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("bin"))
}

fn validate_whisper_model_file(path: &Path) -> Result<(), String> {
    let metadata = std::fs::metadata(path)
        .map_err(|err| format!("Cannot read Whisper model at {}: {err}", path.display()))?;
    if metadata.len() >= MIN_WHISPER_MODEL_BYTES {
        return Ok(());
    }

    let looks_like_lfs_pointer = std::fs::read(path)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .is_some_and(|content| content.starts_with("version https://git-lfs.github.com/spec/v1"));

    if looks_like_lfs_pointer {
        return Err(
            "Whisper model file is a Git LFS pointer, not the downloaded model. \
             Run: git lfs pull --include=\"src-tauri/models/whisper/*.bin\""
                .to_string(),
        );
    }

    Err(format!(
        "Whisper model at {} is too small ({} bytes). \
         Download ggml-base.en.bin into src-tauri/models/whisper/ (see models/whisper/README.md).",
        path.display(),
        metadata.len()
    ))
}

fn find_model_in_dir(dir: &Path) -> Option<PathBuf> {
    for name in PREFERRED_MODELS {
        let candidate = dir.join(name);
        if is_whisper_model_file(&candidate) {
            return Some(candidate);
        }
    }

    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if is_whisper_model_file(&path) {
            return Some(path);
        }
    }
    None
}

fn resolve_whisper_model_path(app: &AppHandle, model_path: String) -> Result<String, String> {
    let trimmed = model_path.trim();
    if !trimmed.is_empty() {
        let provided = PathBuf::from(trimmed);
        if !provided.exists() {
            return Err(format!("Whisper model path does not exist: {trimmed}"));
        }
        if !is_whisper_model_file(&provided) {
            return Err(format!(
                "Whisper model path must be a .bin GGML file: {trimmed}"
            ));
        }
        validate_whisper_model_file(&provided)?;
        return Ok(normalize_path(provided));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("models").join("whisper"));
        }
    }

    candidates.push(PathBuf::from(BUNDLED_WHISPER_ROOT));

    if let Ok(resource_path) = app
        .path()
        .resolve("models/whisper", BaseDirectory::Resource)
    {
        candidates.push(resource_path);
    }

    candidates.push(PathBuf::from("models/whisper"));
    candidates.push(PathBuf::from("src-tauri/models/whisper"));

    if let Ok(app_data) = app.path().app_data_dir() {
        candidates.push(app_data.join("models").join("whisper"));
    }

    for candidate in candidates {
        if candidate.is_dir() {
            if let Some(model) = find_model_in_dir(&candidate) {
                validate_whisper_model_file(&model)?;
                return Ok(normalize_path(model));
            }
        } else if is_whisper_model_file(&candidate) {
            validate_whisper_model_file(&candidate)?;
            return Ok(normalize_path(candidate));
        }
    }

    Err(format!(
        "Whisper model not found. Download ggml-base.en.bin or ggml-tiny.en.bin into src-tauri/models/whisper/ (see models/whisper/README.md)."
    ))
}

fn load_whisper_context(model_path: &str) -> Result<WhisperContext, String> {
    WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|err| format!("Failed to load Whisper model at {model_path}: {err}"))
}

fn whisper_thread_count() -> i32 {
    thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .clamp(1, 8)
}

fn collect_whisper_text(state: &whisper_rs::WhisperState) -> Result<String, String> {
    let num_segments = state.full_n_segments();
    let mut text = String::new();
    for i in 0..num_segments {
        let Some(segment) = state.get_segment(i) else {
            continue;
        };
        let segment = segment
            .to_str_lossy()
            .map_err(|err| format!("Failed to read segment {i}: {err}"))?;
        if !segment.is_empty() {
            if !text.is_empty() && !text.ends_with(' ') {
                text.push(' ');
            }
            text.push_str(segment.trim());
        }
    }
    Ok(text.trim().to_string())
}

fn run_whisper(
    ctx: &WhisperContext,
    samples: &[f32],
    partial: bool,
) -> Result<String, String> {
    if samples.len() < (WHISPER_SAMPLE_RATE as f64 * MIN_UTTERANCE_SECS) as usize {
        return Ok(String::new());
    }

    let mut state = ctx
        .create_state()
        .map_err(|err| format!("Failed to create Whisper state: {err}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_n_threads(whisper_thread_count());

    if partial {
        params.set_no_context(true);
        params.set_single_segment(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
    }

    state
        .full(params, samples)
        .map_err(|err| format!("Whisper inference failed: {err}"))?;

    collect_whisper_text(&state)
}

fn transcribe_with_retry(
    ctx: &WhisperContext,
    samples: &[f32],
    partial: bool,
) -> Result<String, String> {
    let mut last_err = String::new();
    for attempt in 0..INFERENCE_RETRIES {
        match run_whisper(ctx, samples, partial) {
            Ok(text) => return Ok(text),
            Err(err) => {
                last_err = err;
                if attempt + 1 < INFERENCE_RETRIES {
                    thread::sleep(Duration::from_millis(80));
                }
            }
        }
    }
    Err(last_err)
}

fn frame_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

fn downsample_nearest(input: &[f32], input_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || input_rate == 0 || target_rate == 0 {
        return Vec::new();
    }
    if input_rate == target_rate {
        return input.to_vec();
    }

    let ratio = input_rate as f64 / target_rate as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_idx = (i as f64 * ratio).floor() as usize;
        let sample = input.get(src_idx).copied().unwrap_or(0.0);
        out.push(sample.clamp(-1.0, 1.0));
    }
    out
}

fn mono_from_interleaved<T: Copy>(data: &[T], channels: usize, to_f32: impl Fn(T) -> f32) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(channels)
        .map(|frame| {
            let sum: f32 = frame.iter().map(|&sample| to_f32(sample)).sum();
            (sum / channels as f32).clamp(-1.0, 1.0)
        })
        .collect()
}

struct VadBuffer {
    utterance: Vec<f32>,
    silence_ms: f64,
    speech_ms: f64,
    had_speech: bool,
    was_speaking: bool,
    frame_ms: f64,
    partial_seq: u64,
    samples_since_partial: usize,
}

impl VadBuffer {
    fn new(frame_ms: f64) -> Self {
        Self {
            utterance: Vec::new(),
            silence_ms: 0.0,
            speech_ms: 0.0,
            had_speech: false,
            was_speaking: false,
            frame_ms,
            partial_seq: 0,
            samples_since_partial: 0,
        }
    }

    fn partial_interval_samples() -> usize {
        (WHISPER_SAMPLE_RATE as f64 * PARTIAL_INTERVAL_SECS) as usize
    }

    fn max_utterance_samples() -> usize {
        (WHISPER_SAMPLE_RATE as f64 * MAX_UTTERANCE_SECS) as usize
    }

    fn reset_utterance(&mut self) {
        self.utterance.clear();
        self.had_speech = false;
        self.was_speaking = false;
        self.silence_ms = 0.0;
        self.speech_ms = 0.0;
        self.samples_since_partial = 0;
    }

    fn take_final_chunk(&mut self) -> Option<Vec<f32>> {
        let min_samples = (WHISPER_SAMPLE_RATE as f64 * MIN_UTTERANCE_SECS) as usize;
        if self.utterance.len() >= min_samples {
            let chunk = std::mem::take(&mut self.utterance);
            self.reset_utterance();
            return Some(chunk);
        }
        self.reset_utterance();
        None
    }

    fn maybe_partial(&mut self) -> Option<(Vec<f32>, u64)> {
        if self.samples_since_partial < Self::partial_interval_samples() {
            return None;
        }
        let min_samples = (WHISPER_SAMPLE_RATE as f64 * MIN_UTTERANCE_SECS) as usize;
        if self.utterance.len() < min_samples {
            return None;
        }
        self.samples_since_partial = 0;
        self.partial_seq = self.partial_seq.wrapping_add(1);
        Some((self.utterance.clone(), self.partial_seq))
    }

    fn push_frame(&mut self, frame: &[f32]) -> VadEvent {
        let energy = frame_rms(frame);
        let is_speech = energy >= RMS_SILENCE_THRESHOLD;

        if is_speech {
            let just_started = !self.was_speaking;
            self.had_speech = true;
            self.was_speaking = true;
            self.silence_ms = 0.0;
            self.speech_ms += self.frame_ms;
            self.utterance.extend_from_slice(frame);
            self.samples_since_partial += frame.len();

            if self.utterance.len() >= Self::max_utterance_samples() {
                if let Some(chunk) = self.take_final_chunk() {
                    return VadEvent::Final(chunk);
                }
            }

            if just_started {
                return VadEvent::SpeechStarted;
            }

            if let Some((chunk, id)) = self.maybe_partial() {
                return VadEvent::Partial(chunk, id);
            }

            return VadEvent::None;
        }

        if self.had_speech {
            self.utterance.extend_from_slice(frame);
            self.silence_ms += self.frame_ms;
            if self.silence_ms >= SILENCE_END_SECS * 1000.0 {
                if let Some(chunk) = self.take_final_chunk() {
                    return VadEvent::Final(chunk);
                }
                self.was_speaking = false;
                return VadEvent::SpeechEnded;
            }
            return VadEvent::None;
        }

        VadEvent::None
    }
}

fn drain_inference_batch(rx: &Receiver<InferenceMessage>) -> Vec<InferenceMessage> {
    let first = match rx.recv() {
        Ok(msg) => msg,
        Err(_) => return Vec::new(),
    };
    let mut batch = vec![first];
    while let Ok(msg) = rx.try_recv() {
        batch.push(msg);
    }
    batch
}

fn collapse_partial_jobs(batch: Vec<InferenceMessage>) -> (Vec<InferenceMessage>, Option<(Vec<f32>, u64)>) {
    let mut ordered = Vec::new();
    let mut latest_partial: Option<(Vec<f32>, u64)> = None;

    for msg in batch {
        match msg {
            InferenceMessage::Partial(samples, id) => latest_partial = Some((samples, id)),
            other => ordered.push(other),
        }
    }

    (ordered, latest_partial)
}

fn run_inference_worker(
    ctx: Arc<WhisperContext>,
    app: AppHandle,
    inference_rx: Receiver<InferenceMessage>,
) {
    let latest_partial_id = Arc::new(AtomicU64::new(0));

    loop {
        let batch = drain_inference_batch(&inference_rx);
        if batch.is_empty() {
            break;
        }

        let (mut jobs, latest_partial) = collapse_partial_jobs(batch);
        if let Some((samples, id)) = latest_partial {
            jobs.push(InferenceMessage::Partial(samples, id));
        }

        for job in jobs {
            match job {
                InferenceMessage::Stop => return,
                InferenceMessage::Final(samples) => {
                    latest_partial_id.store(0, Ordering::Release);
                    match transcribe_with_retry(ctx.as_ref(), &samples, false) {
                        Ok(text) if !text.is_empty() => {
                            emit_stt_listening(&app, false);
                            emit_stt_partial(&app, String::new());
                            emit_stt_result(&app, text);
                        }
                        Ok(_) => emit_stt_listening(&app, false),
                        Err(err) => emit_stt_error(&app, err),
                    }
                }
                InferenceMessage::Partial(samples, id) => {
                    latest_partial_id.store(id, Ordering::Release);
                    match transcribe_with_retry(ctx.as_ref(), &samples, true) {
                        Ok(text) if !text.is_empty() => {
                            if latest_partial_id.load(Ordering::Acquire) == id {
                                emit_stt_listening(&app, true);
                                emit_stt_partial(&app, text);
                            }
                        }
                        Ok(_) => {}
                        Err(err) => {
                            if latest_partial_id.load(Ordering::Acquire) == id {
                                emit_stt_error(&app, err);
                            }
                        }
                    }
                }
            }
        }
    }
}

fn build_loopback_stream(
    app: AppHandle,
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    source_sample_rate: u32,
    inference_tx: Sender<InferenceMessage>,
) -> Result<cpal::Stream, String> {
    let channels = usize::from(config.channels.max(1));
    let frame_samples =
        ((WHISPER_SAMPLE_RATE as f64 * FRAME_MS as f64) / 1000.0).round() as usize;
    let frame_ms = FRAME_MS as f64;
    let mut vad = VadBuffer::new(frame_ms);
    let mut pending_16k: Vec<f32> = Vec::new();

    let push_pending = move |pending: &mut Vec<f32>, vad: &mut VadBuffer| {
        while pending.len() >= frame_samples {
            let frame: Vec<f32> = pending.drain(..frame_samples).collect();
            match vad.push_frame(&frame) {
                VadEvent::SpeechStarted => emit_stt_listening(&app, true),
                VadEvent::SpeechEnded => emit_stt_listening(&app, false),
                VadEvent::Partial(chunk, id) => {
                    if inference_tx
                        .send(InferenceMessage::Partial(chunk, id))
                        .is_err()
                    {
                        break;
                    }
                }
                VadEvent::Final(chunk) => {
                    if inference_tx
                        .send(InferenceMessage::Final(chunk))
                        .is_err()
                    {
                        break;
                    }
                }
                VadEvent::None => {}
            }
        }
    };

    let error_callback = |err| eprintln!("Audio capture error: {err}");

    match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                config,
                move |data: &[f32], _| {
                    let mono = mono_from_interleaved(data, channels, |s| s);
                    let mono_16k = downsample_nearest(&mono, source_sample_rate, WHISPER_SAMPLE_RATE);
                    pending_16k.extend_from_slice(&mono_16k);
                    push_pending(&mut pending_16k, &mut vad);
                },
                error_callback,
                None,
            )
            .map_err(|err| format!("Failed to build f32 loopback stream: {err}")),
        SampleFormat::I16 => device
            .build_input_stream(
                config,
                move |data: &[i16], _| {
                    let mono = mono_from_interleaved(data, channels, |s| {
                        s as f32 / i16::MAX as f32
                    });
                    let mono_16k = downsample_nearest(&mono, source_sample_rate, WHISPER_SAMPLE_RATE);
                    pending_16k.extend_from_slice(&mono_16k);
                    push_pending(&mut pending_16k, &mut vad);
                },
                error_callback,
                None,
            )
            .map_err(|err| format!("Failed to build i16 loopback stream: {err}")),
        SampleFormat::U16 => device
            .build_input_stream(
                config,
                move |data: &[u16], _| {
                    let mono = mono_from_interleaved(data, channels, |s| {
                        (f32::from(s) - 32768.0) / 32768.0
                    });
                    let mono_16k = downsample_nearest(&mono, source_sample_rate, WHISPER_SAMPLE_RATE);
                    pending_16k.extend_from_slice(&mono_16k);
                    push_pending(&mut pending_16k, &mut vad);
                },
                error_callback,
                None,
            )
            .map_err(|err| format!("Failed to build u16 loopback stream: {err}")),
        other => Err(format!("Unsupported sample format: {other:?}")),
    }
}

fn start_listening_thread(
    app: AppHandle,
    ctx: Arc<WhisperContext>,
    control_rx: Receiver<ControlMessage>,
) -> Result<(), String> {
    let (inference_tx, inference_rx) = mpsc::channel::<InferenceMessage>();
    let inference_app = app.clone();
    let inference_ctx = Arc::clone(&ctx);

    thread::spawn(move || {
        run_inference_worker(inference_ctx, inference_app, inference_rx);
    });

    thread::spawn(move || {
        let clear_listen_state = || {
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut guard) = state.listen_control.lock() {
                    *guard = None;
                }
            }
        };

        let host = cpal::default_host();
        let device = match host.default_output_device() {
            Some(device) => device,
            None => {
                emit_stt_error(&app, "No system output device found for loopback capture.".into());
                clear_listen_state();
                return;
            }
        };

        let output_config = match device.default_output_config() {
            Ok(config) => config,
            Err(err) => {
                emit_stt_error(&app, format!("Unable to read output device config: {err}"));
                clear_listen_state();
                return;
            }
        };

        let source_sample_rate = output_config.sample_rate().0;
        let stream_config = output_config.config();
        let sample_format = output_config.sample_format();

        let stream = match build_loopback_stream(
            app.clone(),
            &device,
            &stream_config,
            sample_format,
            source_sample_rate,
            inference_tx.clone(),
        ) {
            Ok(stream) => stream,
            Err(err) => {
                emit_stt_error(&app, err);
                clear_listen_state();
                return;
            }
        };

        if let Err(err) = stream.play() {
            emit_stt_error(&app, format!("Failed to start audio stream: {err}"));
            clear_listen_state();
            return;
        }

        loop {
            match control_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(ControlMessage::Stop) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let _ = inference_tx.send(InferenceMessage::Stop);
        drop(stream);
        clear_listen_state();
    });

    Ok(())
}

#[tauri::command]
async fn initialize_whisper(
    app: AppHandle,
    state: State<'_, AppState>,
    model_path: String,
) -> Result<(), String> {
    let resolved = resolve_whisper_model_path(&app, model_path)?;
    let ctx = tokio::task::spawn_blocking(move || load_whisper_context(&resolved))
        .await
        .map_err(|err| format!("Whisper initialization task failed: {err}"))??;

    let mut guard = state
        .whisper
        .lock()
        .map_err(|_| "Whisper state lock poisoned".to_string())?;
    *guard = Some(Arc::new(ctx));
    Ok(())
}

#[tauri::command]
async fn start_interview_listening(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ctx = {
        let guard = state
            .whisper
            .lock()
            .map_err(|_| "Whisper state lock poisoned".to_string())?;
        guard
            .clone()
            .ok_or_else(|| "Whisper is not initialized. Call initialize_whisper first.".to_string())?
    };

    let mut listen_guard = state
        .listen_control
        .lock()
        .map_err(|_| "Listen state lock poisoned".to_string())?;
    if listen_guard.is_some() {
        return Ok(());
    }

    let (control_tx, control_rx) = mpsc::channel::<ControlMessage>();
    *listen_guard = Some(control_tx);
    drop(listen_guard);

    let worker_app = app.clone();
    start_listening_thread(worker_app, ctx, control_rx)?;

    Ok(())
}

#[tauri::command]
async fn stop_interview_listening(state: State<'_, AppState>) -> Result<(), String> {
    let mut listen_guard = state
        .listen_control
        .lock()
        .map_err(|_| "Listen state lock poisoned".to_string())?;
    if let Some(tx) = listen_guard.take() {
        let _ = tx.send(ControlMessage::Stop);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            eprintln!("[api] Using remote CUS Tech API (VITE_API_URL / https://www.custech.co).");

            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;

            window.set_content_protected(true)?;

            #[cfg(target_os = "windows")]
            {
                let hwnd_raw = window.hwnd()?.0 as isize;
                unsafe {
                    let hwnd = HWND(hwnd_raw as _);
                    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_TOOLWINDOW.0 as isize);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_api_keys,
            initialize_whisper,
            start_interview_listening,
            stop_interview_listening
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
