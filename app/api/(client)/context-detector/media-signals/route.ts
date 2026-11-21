import { contextDetectorErrorResponse } from "@/lib/context-detector/http";
import {
    analyzeImage,
    MAX_IMAGE_BYTES,
    MediaSignalsError,
    MULTIPART_OVERHEAD_BYTES,
    sanitizeFileName,
} from "@/lib/context-detector/media";
import { runOcr } from "@/lib/context-detector/ocr";
import { MediaSignalsResponse } from "@/lib/context-detector/types";
import { NextRequest, NextResponse } from "next/server";

const MAX_MB = MAX_IMAGE_BYTES / (1024 * 1024);
const TRUE_VALUES = ["true", "1", "on", "yes"];
const FALSE_VALUES = ["false", "0", "off", "no", ""];

// Optional multipart field "ocr": runs local OCR (tesseract.js) on the image.
const parseOcrFlag = (value: FormDataEntryValue | null): boolean => {
    if (value === null) {
        return false;
    }
    const text = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    if (text !== undefined && TRUE_VALUES.includes(text)) {
        return true;
    }
    if (text !== undefined && FALSE_VALUES.includes(text)) {
        return false;
    }
    throw new MediaSignalsError(
        "Le champ « ocr » doit valoir true ou false.",
        400,
        "INVALID_OCR_FLAG",
    );
};

// docs/adr-content-detector.md §3: multipart upload, 1 image, <= 4 MB,
// JPEG/PNG/WebP checked on the file bytes. No remote AI call; the file is
// analysed in memory and never stored. With ocr=true, local OCR also extracts
// the image text (always marked indicative).
export async function POST(req: NextRequest): Promise<NextResponse> {
    try {
        const contentType = req.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
            throw new MediaSignalsError(
                "Envoyez l'image en multipart/form-data dans le champ « file ».",
                415,
                "MULTIPART_REQUIRED",
            );
        }

        // Reject oversized uploads before reading the body when the size is announced.
        const contentLength = Number(req.headers.get("content-length"));
        if (contentLength > MAX_IMAGE_BYTES + MULTIPART_OVERHEAD_BYTES) {
            throw new MediaSignalsError(
                `Fichier trop volumineux : ${MAX_MB} Mo maximum.`,
                413,
                "FILE_TOO_LARGE",
            );
        }

        let form: FormData;
        try {
            form = await req.formData();
        } catch {
            throw new MediaSignalsError(
                "Corps multipart invalide ou incomplet.",
                400,
                "INVALID_MULTIPART",
            );
        }

        const entries = form.getAll("file");
        if (entries.length === 0) {
            throw new MediaSignalsError(
                "Aucun fichier reçu : ajoutez une image dans le champ « file ».",
                400,
                "FILE_REQUIRED",
            );
        }
        if (entries.length > 1) {
            throw new MediaSignalsError(
                "Un seul fichier par requête.",
                400,
                "TOO_MANY_FILES",
            );
        }

        const ocrRequested = parseOcrFlag(form.get("ocr"));
        const file = entries[0];
        if (typeof file === "string") {
            throw new MediaSignalsError(
                "Le champ « file » doit contenir un fichier, pas du texte.",
                400,
                "FILE_REQUIRED",
            );
        }
        if (file.size === 0) {
            throw new MediaSignalsError("Le fichier est vide.", 400, "EMPTY_FILE");
        }
        if (file.size > MAX_IMAGE_BYTES) {
            throw new MediaSignalsError(
                `Fichier trop volumineux : ${MAX_MB} Mo maximum.`,
                413,
                "FILE_TOO_LARGE",
            );
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        const result: MediaSignalsResponse = analyzeImage(
            bytes,
            sanitizeFileName(file.name),
            file.type || null,
        );
        if (ocrRequested) {
            // Runs after validation, so OCR never sees a rejected file.
            result.ocr = await runOcr(bytes);
        }

        return NextResponse.json(result, { status: 200 });
    } catch (error) {
        return contextDetectorErrorResponse(error);
    }
}
