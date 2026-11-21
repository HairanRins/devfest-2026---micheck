// Fake of tesseract.js createWorker() used by lib/context-detector/ocr.ts.
const state = (globalThis.__fakeTesseract ??= { text: "", confidence: 0, workers: 0 });

export async function createWorker(langs, oem, options) {
    state.workers += 1;
    state.langs = langs;
    state.oem = oem;
    state.options = options;
    return {
        async recognize(image) {
            state.lastImageBytes = image.length;
            return { data: { text: state.text, confidence: state.confidence } };
        },
    };
}
