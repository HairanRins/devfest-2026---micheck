// Fake of the parts of node-llama-cpp used by lib/context-detector/local-llm.ts.
// Tests set globalThis.__fakeLlama.answers.{extraction,analysis}; calls are recorded.
const state = (globalThis.__fakeLlama ??= { answers: {}, calls: [], loads: 0, disposed: 0 });

const stepOf = (schema) => (schema?.properties?.claims ? "extraction" : "analysis");

export async function getLlama() {
    return {
        async loadModel({ modelPath }) {
            state.loads += 1;
            state.modelPath = modelPath;
            return {
                async createContext({ contextSize }) {
                    state.contextSize = contextSize;
                    return {
                        getSequence: () => ({}),
                        dispose: async () => {
                            state.disposed += 1;
                        },
                    };
                },
            };
        },
        async createGrammarForJsonSchema(schema) {
            return { schema, parse: (text) => JSON.parse(text) };
        },
    };
}

export class LlamaChatSession {
    constructor({ systemPrompt }) {
        this.systemPrompt = systemPrompt;
    }

    async prompt(userPrompt, { grammar, temperature, maxTokens, signal }) {
        const step = stepOf(grammar.schema);
        state.calls.push({ step, temperature, maxTokens, hasSignal: Boolean(signal), schema: grammar.schema });
        const answer = state.answers[step];
        if (!answer) {
            throw new Error(`fake node-llama-cpp: no answer configured for ${step}`);
        }
        return JSON.stringify(answer);
    }
}
