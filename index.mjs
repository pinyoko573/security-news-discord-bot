import http from 'http';
import Anthropic from '@anthropic-ai/sdk';

import { SYSTEM_PROMPT } from './prompt.mjs';

import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

const secret_arn = process.env.SECRET_ARN;
const discord_dm_id = process.env.DISCORD_DM_ID;

// Fetches a secret from AWS Secrets Manager using the local endpoint provided by AWS Lambda.
const fetchSecret = async (secretId) => {
  const options = {
    hostname: 'localhost',
    port: 2773,
    path: `/secretsmanager/get?secretId=${secretId}`,
    headers: {
      'X-Aws-Parameters-Secrets-Token': process.env.AWS_SESSION_TOKEN
    }
  };

  const response = await new Promise((resolve, reject) => {
    http.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    }).on('error', reject);
  });

  if (response.statusCode !== 200) {
    throw new Error(`Failed to fetch secret, status: ${response.statusCode}`);
  }

  const parsed = JSON.parse(response.body);
  return JSON.parse(parsed.SecretString);
};

// Uses the Anthropic API to generate a cybersecurity news briefing based on the provided system prompt.
const fetchNews = async (api_key, system_prompt) => {
  const client = new Anthropic({ apiKey: api_key });

  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    system: system_prompt,
    messages: [{ role: "user", content: "Generate this week's cybersecurity briefing." }],
    tools: [{
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 10
    }],
  });

  // Collect every text block and use the last one (the final answer after all searches)
  const textBlocks = msg.content.filter(b => b.type === "text").map(b => b.text);
  const raw = textBlocks[textBlocks.length - 1] ?? "";

  // Remove any HTML/XML tags (e.g. <cite index="...">...</cite>) from the raw text
  const strippedRaw = raw.replace(/<[^>]+>/g, "").trim();
  
  // Extract the JSON object from anywhere in the text (ignores preamble + code fences)
  const start = strippedRaw.indexOf("{");
  const end = strippedRaw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in model response: " + strippedRaw.slice(0, 200));
  }

  const parsed = JSON.parse(strippedRaw.slice(start, end + 1));
  return parsed;
};

// Sends a message to a specified Discord DM channel using the Discord API.
const sendMessage = async (dm_id, api_key, message) => {
  const rest = new REST({ version: '10' }).setToken(api_key);

  try {
    await rest.post(Routes.channelMessages(dm_id), {
      body: {
        content: message,
        flags: 4, // MessageFlags.SuppressEmbeds
      },
    });
  } catch (error) {
    throw new Error(`Discord API error: ${error.message}`);
  }
}

export const handler = async (event) => {
  try {
    const secret = await fetchSecret(secret_arn);

    const today = new Date().toISOString().slice(0, 10);
    const system_prompt = SYSTEM_PROMPT.replace("{{CURRENT_DATE}}", today);
    const news = await fetchNews(secret.CLAUDE_API_KEY, system_prompt);

    await sendMessage(discord_dm_id, secret.DISCORD_API_KEY, "Good morning! Here is this week's cybersecurity briefing:");
    for (const item of news.articles) {
      const message = `**${item.title}**\n\n${item.summary}\n\n📰 ${item.source}\n${item.url}`;
      await sendMessage(discord_dm_id, secret.DISCORD_API_KEY, message);
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message
      })
    };
  }
};
