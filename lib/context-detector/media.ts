import {
    AiImage,
    isVisionConfigured,
    requestStructuredJson,
} from "@/lib/context-detector/ai";
import { MAX_VIDEO_FRAMES, parseImageDataUrl } from "@/lib/context-detector/image-data";
import {
    buildMediaObservationSystemPrompt,
    buildMediaObservationUserPrompt,
} from "@/lib/context-detector/prompts";
import { InvestigationInput, MediaFinding } from "@/lib/context-detector/types";

const MAX_VISION_TARGETS = 3;

export interface VisionMediaResult {
    media_id: string;
    kind: "image" | "video";
    frame_count: number;
    observations: string[];
    ocr?: string;
    context_clues: string[];
    limitations: string[];
}

export interface MediaAnalysis {
    results: VisionMediaResult[];
    limitations: string[];
}

export interface MediaTarget {
    media_id: string;
    kind: "image" | "video";
    images: AiImage[];
    name?: string;
}

const asStringArray = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter(
              (item): item is string =>
                  typeof item === "string" && item.trim().length > 0,
          )
        : [];

export const collectMediaTargets = (
    input: InvestigationInput,
): { targets: MediaTarget[]; limitations: string[] } => {
    const targets: MediaTarget[] = [];
    const limitations: string[] = [];

    (input.media ?? []).forEach((media, index) => {
        const mediaId = `M${index + 1}`;

        if (media.type === "image") {
            const image = parseImageDataUrl(media.dataUrl);
            if (image) {
                targets.push({
                    media_id: mediaId,
                    kind: "image",
                    images: [image],
                    name: media.name,
                });
            } else if (media.url) {
                limitations.push(
                    `${mediaId} : l'image distante n'est pas téléchargée ; envoyez-la dans dataUrl pour une analyse visuelle.`,
                );
            } else if (media.dataUrl) {
                limitations.push(
                    `${mediaId} : dataUrl ignoré (JPEG, PNG ou WebP attendu, 4 Mo maximum).`,
                );
            }
            return;
        }

        if (media.type === "video") {
            const frames = (media.frames ?? [])
                .map((frame) => parseImageDataUrl(frame))
                .filter((frame): frame is AiImage => Boolean(frame))
                .slice(0, MAX_VIDEO_FRAMES);

            if (frames.length > 0) {
                targets.push({
                    media_id: mediaId,
                    kind: "video",
                    images: frames,
                    name: media.name,
                });
            } else {
                limitations.push(
                    `${mediaId} : vidéo non analysée visuellement ; fournissez jusqu'à ${MAX_VIDEO_FRAMES} images clés dans frames, sinon seules les métadonnées sont utilisées.`,
                );
            }
        }
    });

    if (targets.length > MAX_VISION_TARGETS) {
        limitations.push(
            `Seuls les ${MAX_VISION_TARGETS} premiers médias sont analysés visuellement pour limiter le coût.`,
        );
    }

    return { targets: targets.slice(0, MAX_VISION_TARGETS), limitations };
};

const normalizeVisionResult = (
    raw: Record<string, unknown>,
    target: MediaTarget,
): VisionMediaResult | undefined => {
    const observations = asStringArray(raw.observations);
    if (observations.length === 0) {
        return undefined;
    }
    const ocr =
        typeof raw.ocr === "string" && raw.ocr.trim() ? raw.ocr.trim() : undefined;

    return {
        media_id: target.media_id,
        kind: target.kind,
        frame_count: target.images.length,
        observations,
        ...(ocr ? { ocr } : {}),
        context_clues: asStringArray(raw.context_clues),
        limitations: asStringArray(raw.limitations),
    };
};

export const analyseMedia = async (
    input: InvestigationInput,
    language?: string,
): Promise<MediaAnalysis> => {
    const { targets, limitations } = collectMediaTargets(input);
    if (targets.length === 0) {
        return { results: [], limitations };
    }
    if (!isVisionConfigured()) {
        return {
            results: [],
            limitations: [
                ...limitations,
                "Aucun modèle vision configuré : l'analyse visuelle n'a pas été effectuée.",
            ],
        };
    }

    const results: VisionMediaResult[] = [];

    for (const target of targets) {
        try {
            const raw = await requestStructuredJson(
                buildMediaObservationSystemPrompt(language),
                buildMediaObservationUserPrompt(
                    target.media_id,
                    target.kind,
                    target.images.length,
                ),
                target.images,
            );
            const result = normalizeVisionResult(raw, target);
            if (!result) {
                limitations.push(
                    `${target.media_id} : aucune observation exploitable renvoyée par le modèle vision.`,
                );
                continue;
            }
            results.push(result);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(
                "Context Detector vision failed:",
                target.media_id,
                reason,
            );
            limitations.push(
                `${target.media_id} : analyse visuelle indisponible (${reason.slice(0, 160)}).`,
            );
        }
    }

    return { results, limitations };
};

export const toMediaFindings = (
    results: VisionMediaResult[],
): MediaFinding[] =>
    results.map((result) => ({
        media_id: result.media_id,
        visual_observations: result.observations,
        ...(result.ocr ? { ocr: result.ocr } : {}),
        matches: [],
        source_ids: [],
        limitations: [
            ...result.limitations,
            result.kind === "video"
                ? "Images clés fournies par le client : la vidéo complète, l'audio et la date d'origine n'ont pas été vérifiés."
                : "Inspection visuelle seule : elle ne prouve ni l'authenticité, ni une manipulation, ni une génération par IA.",
        ],
    }));
