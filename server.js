
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  "http://localhost:5173",
  "https://client-ten-zeta-68.vercel.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "1mb" }));

const PROVIDERS = {
  openai: {
    url: "https://api.openai.com/v1",
    key: process.env.OPENAI_API_KEY,
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1",
    key: process.env.OPENROUTER_API_KEY,
  },
  nvidia: {
    url: "https://integrate.api.nvidia.com/v1",
    key: process.env.NVIDIA_API_KEY,
  },
};

// Fetch models from providers
async function fetchModels(provider, config) {
  if (!config.key) {
    return {
      success: false,
      error: "API key not configured",
      models: [],
    };
  }

  try {
    const response = await fetch(`${config.url}/models`, {
      headers: {
        Authorization: `Bearer ${config.key}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Provider returned ${response.status}: ${errorText.slice(0, 200)}`
      );
    }

    const result = await response.json();

    const models = (result.data || []).map((model) => {
      const architecture = model.architecture || {};

      return {
        id: model.id,
        name: model.name || model.id,
        provider,
        contextLength: model.context_length || null,
        inputModalities: architecture.input_modalities || ["text"],
        outputModalities: architecture.output_modalities || ["text"],
        pricing: model.pricing || null,
        description: model.description || "",
      };
    });

    return {
      success: true,
      count: models.length,
      models,
    };
  } catch (error) {
    console.error(`${provider} model fetch failed:`, error.message);

    return {
      success: false,
      error: error.message,
      models: [],
    };
  }
}

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "AI Vet Backend is running!",
  });
});

// Refresh all provider models
app.get("/api/models", async (req, res) => {
  const results = await Promise.all(
    Object.entries(PROVIDERS).map(async ([provider, config]) => [
      provider,
      await fetchModels(provider, config),
    ])
  );

  const providers = Object.fromEntries(results);

  const allModels = Object.values(providers).flatMap(
    (provider) => provider.models
  );

  res.json({
    success: true,
    totalModels: allModels.length,
    providers,
    models: allModels,
  });
});

// AI chat endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { provider, model, messages } = req.body;

    if (!PROVIDERS[provider]) {
      return res.status(400).json({
        success: false,
        error: "Invalid AI provider",
      });
    }

    if (!PROVIDERS[provider].key) {
      return res.status(400).json({
        success: false,
        error: `${provider} API key is not configured`,
      });
    }

    if (!model || typeof model !== "string") {
      return res.status(400).json({
        success: false,
        error: "Please select an AI model",
      });
    }

    if (
      !Array.isArray(messages) ||
      messages.length === 0 ||
      messages.length > 30
    ) {
      return res.status(400).json({
        success: false,
        error: "Please provide between 1 and 30 messages",
      });
    }

    const validMessages = messages.every(
      (message) =>
        message &&
        ["user", "assistant"].includes(message.role) &&
        typeof message.content === "string" &&
        message.content.trim().length > 0 &&
        message.content.length <= 10000
    );

    if (!validMessages) {
      return res.status(400).json({
        success: false,
        error: "Invalid message format",
      });
    }

    const systemMessage = {
      role: "system",
      content: `
You are an AI pet health information assistant.

Help pet owners understand general animal health, nutrition,
care, and common symptoms.

Important safety rules:
- You are not a veterinarian and cannot diagnose animals.
- Never claim that your response replaces a veterinary examination.
- For severe symptoms such as difficulty breathing, seizures,
  collapse, severe bleeding, or suspected poisoning, advise
  immediate veterinary attention.
- Do not prescribe medication or invent medication dosages.
- Ask relevant follow-up questions when important details are missing.
- Explain uncertainty clearly and give practical, safe guidance.
      `.trim(),
    };

    const config = PROVIDERS[provider];

    const headers = {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    };

    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "http://localhost:5173";
      headers["X-Title"] = "AI Vet Platform";
    }

    const response = await fetch(
      `${config.url}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [systemMessage, ...messages],
          temperature: 0.7,
        }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error(`${provider} chat error:`, result);

      return res.status(response.status).json({
        success: false,
        error:
          result.error?.message ||
          result.message ||
          `AI provider returned ${response.status}`,
      });
    }

    const answer = result.choices?.[0]?.message?.content;

    if (!answer) {
      return res.status(502).json({
        success: false,
        error: "The AI provider returned an empty response",
      });
    }

    res.json({
      success: true,
      provider,
      model,
      answer,
    });
  } catch (error) {
    console.error("AI chat error:", error);

    res.status(500).json({
      success: false,
      error: "Something went wrong while processing your AI request",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
