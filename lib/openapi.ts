const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const param = (name: string) => ({ $ref: `#/components/parameters/${name}` });

const response = (description: string, schema: object) => ({
    description,
    content: { "application/json": { schema } },
});

const errorResponse = (description = "Erreur interne du serveur") =>
    response(description, ref("Error"));

const bearer = [{ bearerAuth: [] }];
const nextauth = [{ cookieAuth: [] }];

export const openApiDocument = {
    openapi: "3.0.3",
    info: {
        title: "MiCheck API",
        version: "1.0.0",
        description:
            "Documentation des routes Next.js App Router sous `app/api`. Les routes protégées utilisent soit un token `Bearer` (session DB, rôle ADMIN par défaut), soit la session NextAuth via cookie. Les paramètres `pagination_count` et `pagination_skip` ne sont appliqués que s'ils sont tous deux fournis et non nuls.",
    },
    servers: [{ url: "/", description: "Serveur courant" }],
    tags: [
        { name: "docs", description: "Documentation et spécification" },
        { name: "public", description: "Routes publiques" },
        { name: "auth", description: "Authentification et sessions" },
        { name: "products", description: "Produits et catégories" },
        { name: "users", description: "Utilisateurs" },
        { name: "payments", description: "Paiements et transactions" },
        { name: "admin", description: "Administration" },
        { name: "bot", description: "Assistant IA" },
        {
            name: "context-detector",
            description:
                "Bot d'investigation : extraction d'affirmations, recherche de preuves, chronologie, verdicts nuancés et dossier sourcé.",
        },
    ],
    paths: {
        "/api/docs": {
            get: {
                tags: ["docs"],
                operationId: "getSwaggerUi",
                summary: "Interface Swagger UI",
                responses: {
                    200: {
                        description: "Page HTML Swagger UI",
                        content: { "text/html": { schema: { type: "string" } } },
                    },
                },
            },
        },
        "/api/openapi": {
            get: {
                tags: ["docs"],
                operationId: "getOpenApiDocument",
                summary: "Spécification OpenAPI 3.0.3",
                responses: {
                    200: response("Document OpenAPI", { type: "object" }),
                },
            },
        },
        "/api/category": {
            get: {
                tags: ["public", "products"],
                operationId: "listCategories",
                summary: "Lister les catégories avec leurs produits",
                responses: {
                    200: response("Catégories", {
                        type: "array",
                        items: ref("Category"),
                    }),
                    500: errorResponse(),
                },
            },
        },
        "/api/product/{cuid}": {
            get: {
                tags: ["public", "products"],
                operationId: "getProductByCuid",
                summary: "Récupérer un produit par son cuid",
                parameters: [
                    {
                        name: "cuid",
                        in: "path",
                        required: true,
                        description: "Identifiant public du produit",
                        schema: { type: "string" },
                    },
                ],
                responses: {
                    200: response("Produit", ref("Product")),
                    404: response("Produit introuvable", ref("Message")),
                    500: errorResponse(),
                },
            },
        },
        "/api/auth/[...nextauth]": {
            get: {
                tags: ["auth"],
                operationId: "nextAuthGet",
                summary: "Endpoint NextAuth (GET)",
                responses: {
                    200: response("Réponse NextAuth", { type: "object" }),
                },
            },
            post: {
                tags: ["auth"],
                operationId: "nextAuthPost",
                summary: "Endpoint NextAuth (POST)",
                responses: {
                    200: response("Réponse NextAuth", { type: "object" }),
                },
            },
        },
        "/api/auth/server_session": {
            post: {
                tags: ["auth"],
                operationId: "getServerSessionToken",
                summary: "Récupérer le token de la session serveur",
                responses: {
                    200: response("Token de session", ref("ServerSession")),
                    500: errorResponse(),
                },
            },
        },
        "/api/verify_recaptcha": {
            post: {
                tags: ["public"],
                operationId: "verifyRecaptcha",
                summary: "Vérifier un token reCAPTCHA",
                description:
                    "Le secret reCAPTCHA est lu côté serveur depuis `RECAPTCHA_SITE_SECRET`.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: ref("RecaptchaRequest"),
                        },
                    },
                },
                responses: {
                    200: response("Résultat de la vérification", ref("RecaptchaResponse")),
                    500: errorResponse(),
                },
            },
        },
        "/api/bot/bot_recommandation": {
            post: {
                tags: ["bot"],
                operationId: "botRecommendation",
                summary: "Obtenir une recommandation de l'assistant IA",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": { schema: ref("BotRequest") },
                    },
                },
                responses: {
                    201: response("Réponse de l'assistant", ref("BotResponse")),
                    404: response("Prompt ou réponse absent", ref("Message")),
                    500: errorResponse(),
                },
            },
        },
        "/api/context-detector/skills": {
            get: {
                tags: ["public", "context-detector"],
                operationId: "listContextDetectorSkills",
                summary: "Lister les skills disponibles du détecteur de contexte",
                description:
                    "Chaque skill correspond à une étape du pipeline : extraction, recherche, évaluation des sources, contradiction, chronologie, verdicts et dossier. Les skills qui nécessitent un outil ne sont actifs que si cet outil est configuré côté serveur.",
                responses: {
                    200: response("Skills disponibles", ref("ContextDetectorSkillsResponse")),
                },
            },
        },
        "/api/context-detector/claims": {
            post: {
                tags: ["public", "context-detector"],
                operationId: "extractContextDetectorClaims",
                summary: "Décomposer un contenu en affirmations vérifiables",
                description:
                    "Première étape du pipeline : ne produit ni preuve ni verdict. Nécessite au moins une clé IA (Groq, xAI, Mistral, Gemini ou Hugging Face) ; les fournisseurs sont essayés en cascade selon CONTEXT_DETECTOR_AI_PROVIDERS.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": { schema: ref("ContextDetectorRequest") },
                    },
                },
                responses: {
                    200: response("Affirmations extraites", ref("ContextDetectorClaimsResponse")),
                    400: response("Contenu invalide", ref("Message")),
                    502: errorResponse("Fournisseur IA indisponible"),
                    503: errorResponse("IA non configurée"),
                    500: errorResponse(),
                },
            },
        },
        "/api/context-detector/investigate": {
            post: {
                tags: ["public", "context-detector"],
                operationId: "runContextDetectorInvestigation",
                summary: "Lancer une investigation complète et produire un dossier sourcé",
                description:
                    "Pipeline : extraction des affirmations > plan de recherche > recherche web (Tavily, avec repli Brave ou générique) > évaluation des sources, contradictions et chronologie > verdicts nuancés > dossier Markdown. Les fournisseurs IA (Groq, xAI, Mistral, Gemini, Hugging Face) sont essayés en cascade. Les URL citées proviennent exclusivement des résultats de recherche réellement récupérés : aucune citation n'est inventée. Sans preuve exploitable, les verdicts sont `unverifiable`.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": { schema: ref("ContextDetectorRequest") },
                    },
                },
                responses: {
                    201: response("Dossier de vérification", ref("ContextDetectorInvestigationResponse")),
                    400: response("Contenu invalide", ref("Message")),
                    502: errorResponse("Fournisseur IA indisponible"),
                    503: errorResponse("IA non configurée"),
                    500: errorResponse(),
                },
            },
        },
        "/api/context-detector/investigations/{id}": {
            get: {
                tags: ["public", "context-detector"],
                operationId: "getContextDetectorInvestigation",
                summary: "Récupérer un dossier par son identifiant",
                description:
                    "Les dossiers sont conservés en mémoire pendant 30 minutes dans cette implémentation.",
                parameters: [
                    {
                        name: "id",
                        in: "path",
                        required: true,
                        description: "Identifiant retourné par /api/context-detector/investigate",
                        schema: { type: "string", format: "uuid" },
                    },
                ],
                responses: {
                    200: response("Dossier de vérification", ref("ContextDetectorInvestigationResponse")),
                    404: response("Investigation introuvable", ref("Message")),
                    500: errorResponse(),
                },
            },
        },
        "/api/products": {
            get: {
                tags: ["public", "products"],
                operationId: "listProducts",
                summary: "Lister les produits avec filtres et pagination",
                parameters: [
                    param("PaginationCount"),
                    param("PaginationSkip"),
                    param("CategoryId"),
                    param("PriceRange"),
                    param("SearchValue"),
                ],
                responses: {
                    200: response("Produits paginés", ref("PaginatedProducts")),
                    500: errorResponse(),
                },
            },
        },
        "/api/products/count": {
            get: {
                tags: ["products"],
                operationId: "countProducts",
                summary: "Compter les produits (ADMIN)",
                security: bearer,
                responses: {
                    200: response("Nombre de produits", ref("Count")),
                    401: errorResponse("Non autorisé"),
                    500: errorResponse(),
                },
            },
        },
        "/api/products/recent": {
            get: {
                tags: ["products"],
                operationId: "recentProducts",
                summary: "Produits des 7 derniers jours (ADMIN)",
                security: bearer,
                responses: {
                    200: response("Produits récents", ref("RecentProducts")),
                    401: errorResponse("Non autorisé"),
                    500: errorResponse(),
                },
            },
        },
        "/api/users": {
            get: {
                tags: ["users"],
                operationId: "listUsers",
                summary: "Lister les utilisateurs avec pagination (ADMIN)",
                security: bearer,
                parameters: [param("PaginationCount"), param("PaginationSkip")],
                responses: {
                    200: response("Utilisateurs paginés", ref("PaginatedUsers")),
                    401: errorResponse("Non autorisé"),
                    500: errorResponse(),
                },
            },
        },
        "/api/users/count": {
            get: {
                tags: ["users"],
                operationId: "countUsers",
                summary: "Compter les utilisateurs (ADMIN)",
                security: bearer,
                responses: {
                    200: response("Nombre d'utilisateurs", ref("Count")),
                    401: errorResponse("Non autorisé"),
                    500: errorResponse(),
                },
            },
        },
        "/api/users/get_stats": {
            get: {
                tags: ["users"],
                operationId: "getUserStats",
                summary: "Statistiques d'inscription par mois (ADMIN)",
                security: bearer,
                parameters: [param("Year")],
                responses: {
                    200: response("Statistiques", ref("StatsResponse")),
                    401: errorResponse("Non autorisé"),
                    500: errorResponse(),
                },
            },
        },
        "/api/user": {
            get: {
                tags: ["users", "auth"],
                operationId: "getCurrentUser",
                summary: "Récupérer l'utilisateur de la session NextAuth",
                security: nextauth,
                responses: {
                    200: response("Utilisateur courant", ref("UserResponse")),
                    401: errorResponse("Non autorisé"),
                    404: response("Utilisateur introuvable", ref("Message")),
                    500: errorResponse(),
                },
            },
        },
        "/api/payment": {
            post: {
                tags: ["payments"],
                operationId: "createCheckoutSession",
                summary: "Créer une session de paiement Stripe",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": { schema: ref("CheckoutRequest") },
                    },
                },
                responses: {
                    200: response("Session Stripe", ref("CheckoutSession")),
                    400: response("Produits manquants", ref("Message")),
                    500: errorResponse(),
                },
            },
            get: {
                tags: ["payments"],
                operationId: "listPayments",
                summary: "Lister les transactions avec pagination (ADMIN)",
                security: bearer,
                parameters: [param("PaginationCount"), param("PaginationSkip")],
                responses: {
                    200: response("Transactions paginées", ref("PaginatedTransactions")),
                    401: errorResponse("Non autorisé"),
                    500: errorResponse(),
                },
            },
        },
        "/api/payment/count": {
            get: {
                tags: ["payments"],
                operationId: "countPayments",
                summary: "Compter les transactions d'une année (ADMIN)",
                security: bearer,
                parameters: [param("YearRequired")],
                responses: {
                    200: response("Nombre de transactions", ref("Count")),
                    401: errorResponse("Non autorisé"),
                    404: response("Année manquante", ref("Message")),
                    500: errorResponse(),
                },
            },
        },
        "/api/payment/get_stats": {
            get: {
                tags: ["payments"],
                operationId: "getPaymentStats",
                summary: "Statistiques de paiement par mois (ADMIN)",
                security: bearer,
                parameters: [param("YearRequired")],
                responses: {
                    200: response("Statistiques", ref("StatsResponse")),
                    401: errorResponse("Non autorisé"),
                    404: response("Année manquante", ref("Message")),
                    500: errorResponse(),
                },
            },
        },
        "/api/admin/info": {
            get: {
                tags: ["admin"],
                operationId: "getAdminInfo",
                summary: "Lister les informations administrateur (ADMIN)",
                security: bearer,
                responses: {
                    200: response("Administrateurs", {
                        type: "array",
                        items: ref("AdminInfo"),
                    }),
                    401: errorResponse("Non autorisé"),
                    500: errorResponse(),
                },
            },
        },
        "/api/admin/session/{token}": {
            get: {
                tags: ["admin", "auth"],
                operationId: "getAdminSession",
                summary: "Récupérer une session DB par son token",
                description:
                    "Le token sensible est transmis dans le chemin : à utiliser uniquement en interne.",
                parameters: [
                    {
                        name: "token",
                        in: "path",
                        required: true,
                        description: "Token de session DB",
                        schema: { type: "string" },
                    },
                ],
                responses: {
                    200: response("Session", ref("Session")),
                    404: response("Session introuvable", ref("Message")),
                    500: errorResponse(),
                },
            },
        },
    },
    components: {
        securitySchemes: {
            bearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "DB session token",
                description:
                    "Token de session DB transmis dans `Authorization: Bearer <token>`. Rôle ADMIN par défaut, SUPERADMIN sur certaines routes.",
            },
            cookieAuth: {
                type: "apiKey",
                in: "cookie",
                name: "next-auth.session-token",
                description:
                    "Cookie NextAuth (`__Secure-next-auth.session-token` en production).",
            },
        },
        parameters: {
            PaginationCount: {
                name: "pagination_count",
                in: "query",
                required: false,
                description: "Nombre d'éléments à retourner",
                schema: { type: "integer", minimum: 1 },
            },
            PaginationSkip: {
                name: "pagination_skip",
                in: "query",
                required: false,
                description: "Nombre d'éléments à ignorer",
                schema: { type: "integer", minimum: 0 },
            },
            CategoryId: {
                name: "category_id",
                in: "query",
                required: false,
                description: "Filtrer par catégorie",
                schema: { type: "integer" },
            },
            PriceRange: {
                name: "price_range",
                in: "query",
                required: false,
                description: "Intervalle de prix au format `min-max`",
                schema: { type: "string", example: "10-100" },
            },
            SearchValue: {
                name: "search_value",
                in: "query",
                required: false,
                description: "Recherche insensible à la casse sur le nom",
                schema: { type: "string" },
            },
            Year: {
                name: "year",
                in: "query",
                required: false,
                description: "Année des statistiques",
                schema: { type: "integer", example: 2026 },
            },
            YearRequired: {
                name: "year",
                in: "query",
                required: true,
                description: "Année des statistiques",
                schema: { type: "integer", example: 2026 },
            },
        },
        schemas: {
            Error: {
                type: "object",
                required: ["message"],
                properties: {
                    message: { type: "string" },
                    error: { type: "string", nullable: true },
                },
            },
            Message: {
                type: "object",
                required: ["message"],
                properties: { message: { type: "string" } },
            },
            Count: {
                type: "object",
                required: ["count"],
                properties: { count: { type: "integer" } },
            },
            Stats: {
                type: "object",
                required: ["month", "count"],
                properties: {
                    month: { type: "integer" },
                    count: { type: "integer" },
                },
            },
            StatsResponse: {
                type: "object",
                required: ["stats"],
                properties: {
                    stats: { type: "array", items: ref("Stats") },
                },
            },
            Product: {
                type: "object",
                required: ["id", "cuid", "name", "price", "category"],
                properties: {
                    id: { type: "integer" },
                    cuid: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    price: { type: "number" },
                    modelPath: { type: "string" },
                    groundColor: { type: "string" },
                    config3D: { type: "object" },
                    customisationConfigs: { type: "object" },
                    category: { type: "object" },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                },
            },
            Category: {
                type: "object",
                required: ["id", "name", "products"],
                properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                    products: { type: "array", items: ref("Product") },
                },
            },
            PaginatedProducts: {
                type: "object",
                required: ["paginatedData", "totalCount"],
                properties: {
                    paginatedData: { type: "array", items: ref("Product") },
                    totalCount: { type: "integer" },
                },
            },
            RecentProducts: {
                type: "object",
                required: ["mostSelledProducts"],
                properties: {
                    mostSelledProducts: { type: "array", items: ref("Product") },
                },
            },
            Account: {
                type: "object",
                properties: {
                    type: { type: "string" },
                    provider: { type: "string" },
                    providerAccountId: { type: "string" },
                    expires_at: { type: "string" },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                },
            },
            User: {
                type: "object",
                required: ["id", "email", "name"],
                properties: {
                    id: { type: "string" },
                    email: { type: "string", format: "email" },
                    name: { type: "string" },
                    image: { type: "string", nullable: true },
                    emailVerified: { type: "string", nullable: true },
                    accounts: { type: "array", items: ref("Account") },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                },
            },
            PaginatedUsers: {
                type: "object",
                required: ["paginatedData", "totalCount"],
                properties: {
                    paginatedData: { type: "array", items: ref("User") },
                    totalCount: { type: "integer" },
                },
            },
            UserResponse: {
                type: "object",
                required: ["message", "user"],
                properties: {
                    message: { type: "string" },
                    user: ref("User"),
                },
            },
            Transaction: {
                type: "object",
                required: ["id", "amount", "currency", "status"],
                properties: {
                    id: { type: "integer" },
                    amount: { type: "number" },
                    currency: { type: "string", enum: ["eur"] },
                    status: { type: "string" },
                    customerEmail: { type: "string" },
                    customerName: { type: "string" },
                    userId: { type: "string" },
                    user: ref("User"),
                    stripePaymentIntentId: { type: "string", nullable: true },
                    stripeChargeId: { type: "string", nullable: true },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                },
            },
            PaginatedTransactions: {
                type: "object",
                required: ["paginatedData", "totalCount"],
                properties: {
                    paginatedData: { type: "array", items: ref("Transaction") },
                    totalCount: { type: "integer" },
                },
            },
            CheckoutRequest: {
                type: "object",
                required: ["products"],
                properties: {
                    products: {
                        type: "array",
                        items: {
                            type: "object",
                            required: ["id"],
                            properties: {
                                id: { type: "integer" },
                                image: { type: "string" },
                            },
                        },
                    },
                },
            },
            CheckoutSession: {
                type: "object",
                required: ["id", "client_secret"],
                properties: {
                    id: { type: "string" },
                    client_secret: { type: "string" },
                },
            },
            RecaptchaRequest: {
                type: "object",
                required: ["captchaValue"],
                properties: { captchaValue: { type: "string" } },
            },
            RecaptchaResponse: {
                type: "object",
                required: ["data"],
                properties: { data: { type: "object" } },
            },
            BotRequest: {
                type: "object",
                required: ["prompt"],
                properties: { prompt: { type: "string" } },
            },
            BotResponse: {
                type: "object",
                required: ["message"],
                properties: { message: { type: "string" } },
            },
            ServerSession: {
                type: "object",
                required: ["accessToken"],
                properties: {
                    accessToken: { type: "object", nullable: true },
                },
            },
            Session: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    adminId: { type: "string" },
                    token: { type: "string" },
                    method: { type: "string" },
                    isActive: { type: "boolean" },
                    deviceInfo: { type: "string", nullable: true },
                    ipAddress: { type: "string", nullable: true },
                    userAgent: { type: "string", nullable: true },
                    expiresAt: { type: "string", nullable: true },
                    expires: { type: "string", nullable: true },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                },
            },
            AdminInfo: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    username: { type: "string" },
                    role: { type: "string" },
                    adminFacial: { type: "object", nullable: true },
                    createdAt: { type: "string", format: "date-time" },
                    updatedAt: { type: "string", format: "date-time" },
                },
            },
            ContextDetectorMediaInput: {
                type: "object",
                required: ["type"],
                properties: {
                    type: { type: "string", enum: ["image", "video", "document"] },
                    url: { type: "string", format: "uri" },
                    dataUrl: { type: "string", description: "Média encodé en base64" },
                    name: { type: "string" },
                    mimeType: { type: "string" },
                },
            },
            ContextDetectorRequest: {
                type: "object",
                required: ["content"],
                properties: {
                    content: {
                        oneOf: [
                            { type: "string", description: "Texte ou publication collée" },
                            {
                                type: "object",
                                properties: {
                                    type: {
                                        type: "string",
                                        enum: ["text", "url", "image", "video", "document", "mixed"],
                                    },
                                    text: { type: "string" },
                                    url: { type: "string", format: "uri" },
                                    media: {
                                        type: "array",
                                        items: ref("ContextDetectorMediaInput"),
                                    },
                                },
                            },
                        ],
                    },
                    options: {
                        type: "object",
                        properties: {
                            language: { type: "string", example: "fr" },
                            skills: {
                                type: "array",
                                items: { type: "string" },
                                description: "Identifiants des skills à exécuter",
                            },
                            investigationDate: { type: "string", format: "date-time" },
                            includeReport: { type: "boolean", default: true },
                            skipSearch: { type: "boolean", default: false },
                        },
                    },
                },
            },
            ContextDetectorSkill: {
                type: "object",
                required: ["id", "name", "description", "trigger", "outputKey", "phase", "inputTypes"],
                properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    description: { type: "string" },
                    trigger: { type: "string" },
                    outputKey: { type: "string" },
                    phase: {
                        type: "string",
                        enum: ["preparation", "investigation", "analysis", "reporting"],
                    },
                    inputTypes: {
                        type: "array",
                        items: {
                            type: "string",
                            enum: ["text", "url", "image", "video", "document", "mixed"],
                        },
                    },
                    requiresTool: { type: "string", nullable: true },
                },
            },
            ContextDetectorSkillsResponse: {
                type: "object",
                required: ["count", "skills", "note"],
                properties: {
                    count: { type: "integer" },
                    skills: { type: "array", items: ref("ContextDetectorSkill") },
                    note: { type: "string" },
                },
            },
            ContextDetectorClaim: {
                type: "object",
                required: ["id", "claim_text", "claim_type", "importance", "checkability"],
                properties: {
                    id: { type: "string", example: "C1" },
                    claim_text: { type: "string" },
                    claim_type: {
                        type: "string",
                        enum: [
                            "event",
                            "policy_legal",
                            "statistic",
                            "quote",
                            "identity_allegation",
                            "science_health",
                            "causal",
                            "historical",
                            "other",
                        ],
                    },
                    importance: { type: "string", enum: ["high", "medium", "low"] },
                    entities: { type: "array", items: { type: "string" } },
                    date_or_period: { type: "string" },
                    location: { type: "string" },
                    verification_question: { type: "string" },
                    ambiguities: { type: "array", items: { type: "string" } },
                    checkability: {
                        type: "string",
                        enum: [
                            "verifiable",
                            "partially_verifiable",
                            "not_verifiable",
                            "opinion_or_prediction",
                        ],
                    },
                },
            },
            ContextDetectorClaimsResponse: {
                type: "object",
                required: ["input_type", "input_summary", "language", "investigation_date", "claims"],
                properties: {
                    input_type: {
                        type: "string",
                        enum: ["text", "url", "image", "video", "document", "mixed"],
                    },
                    input_summary: { type: "string" },
                    language: { type: "string" },
                    investigation_date: { type: "string", format: "date-time" },
                    claims: { type: "array", items: ref("ContextDetectorClaim") },
                },
            },
            ContextDetectorEvidence: {
                type: "object",
                required: ["source_id", "claim_ids", "url", "title", "accessed_date", "excerpt"],
                properties: {
                    source_id: { type: "string", example: "S1" },
                    claim_ids: { type: "array", items: { type: "string" } },
                    url: { type: "string", format: "uri" },
                    title: { type: "string" },
                    publisher: { type: "string" },
                    published_date: { type: "string" },
                    accessed_date: { type: "string", format: "date-time" },
                    source_type: { type: "string" },
                    excerpt: { type: "string" },
                    stance: {
                        type: "string",
                        enum: ["supports", "contradicts", "contextualizes", "neutral"],
                    },
                    relevance: { type: "string", enum: ["high", "medium", "low"] },
                    retrieval_notes: { type: "string" },
                },
            },
            ContextDetectorVerdict: {
                type: "object",
                required: ["label", "summary", "confidence", "confidence_rationale"],
                properties: {
                    label: {
                        type: "string",
                        enum: [
                            "confirmed",
                            "refuted",
                            "misleading_or_out_of_context",
                            "unverifiable",
                            "partially_confirmed",
                            "opinion_or_non_factual",
                        ],
                    },
                    summary: { type: "string" },
                    confidence: { type: "string", enum: ["low", "medium", "high"] },
                    confidence_rationale: { type: "string" },
                    key_evidence_ids: { type: "array", items: { type: "string" } },
                    limitations: { type: "array", items: { type: "string" } },
                },
            },
            ContextDetectorDossier: {
                type: "object",
                required: [
                    "investigation_id",
                    "input_type",
                    "investigation_date",
                    "skills_used",
                    "claims",
                    "claim_verdicts",
                    "overall_verdict",
                    "sources",
                ],
                properties: {
                    investigation_id: { type: "string", format: "uuid" },
                    input_summary: { type: "string" },
                    input_type: {
                        type: "string",
                        enum: ["text", "url", "image", "video", "document", "mixed"],
                    },
                    language: { type: "string" },
                    investigation_date: { type: "string", format: "date-time" },
                    skills_used: { type: "array", items: { type: "string" } },
                    claims: { type: "array", items: ref("ContextDetectorClaim") },
                    evidence: { type: "array", items: ref("ContextDetectorEvidence") },
                    claim_verdicts: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                claim_id: { type: "string" },
                                verdict: {
                                    type: "string",
                                    enum: [
                                        "confirmed",
                                        "refuted",
                                        "misleading_or_out_of_context",
                                        "unverifiable",
                                        "partially_confirmed",
                                        "opinion_or_non_factual",
                                    ],
                                },
                                explanation: { type: "string" },
                                confidence: { type: "string", enum: ["low", "medium", "high"] },
                                evidence_ids: { type: "array", items: { type: "string" } },
                                limitations: { type: "array", items: { type: "string" } },
                            },
                        },
                    },
                    overall_verdict: ref("ContextDetectorVerdict"),
                    sources: {
                        type: "array",
                        items: {
                            type: "object",
                            required: ["source_id", "url", "title", "accessed_date"],
                            properties: {
                                source_id: { type: "string" },
                                url: { type: "string", format: "uri" },
                                title: { type: "string" },
                                publisher: { type: "string" },
                                published_date: { type: "string" },
                                accessed_date: { type: "string", format: "date-time" },
                            },
                        },
                    },
                    practical_takeaway: { type: "string" },
                    limitations: { type: "array", items: { type: "string" } },
                },
                description:
                    "Les champs optionnels (search_plan, source_assessments, contradictions, timeline, context_findings, media_findings, video_findings, quote_findings, framing_findings, evidence_gaps) sont présents uniquement lorsque le skill correspondant a été exécuté.",
            },
            ContextDetectorInvestigationResponse: {
                type: "object",
                required: ["investigation_id", "dossier"],
                properties: {
                    investigation_id: { type: "string", format: "uuid" },
                    dossier: ref("ContextDetectorDossier"),
                    report: { type: "string", description: "Dossier Markdown prêt à afficher" },
                },
            },
        },
    },
};
