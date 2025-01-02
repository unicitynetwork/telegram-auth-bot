const TelegramBot = require('node-telegram-bot-api');
const { hash } = require("@unicitylabs/shared/hasher/sha256hasher.js").SHA256Hasher;
require('dotenv').config();

const botToken = process.env.BOT_TOKEN;
const botSecret = process.env.BOT_SECRET;

if (!botToken) {
  console.error('Error: BOT_TOKEN not set in .env file');
  process.exit(1);
}

if (!botToken) {
  console.error('Error: BOT_SECRET not set in .env file');
  process.exit(1);
}

const bot = new TelegramBot(botToken, { polling: true });


// Helper function to derive a secret from user ID
const deriveSecret = (userId) => {
  return hash(String(userId)+botSecret);
};

// Commands
bot.onText(/\/getaddr/, (msg) => {
  const userId = msg.from.id;
  const secret = deriveSecret(userId);

  const address = generateRecipientPubkeyAddr(secret);
  bot.sendMessage(msg.chat.id, `${address}`);
});

bot.onText(/\/sign (.+)/, (msg, match) => {
  const hashToSign = match[1];
  if (!/^[0-9a-fA-F]{64}$/.test(hashToSign)) {
    return bot.sendMessage(
      msg.chat.id,
      'Error: Input must be a 64-character hexadecimal string.'
    );
  }

  const userId = msg.from.id;
  const secret = deriveSecret(userId);
  const signer = getTxSigner(secret);

  bot.sendMessage(msg.chat.id, `${signer.sign(hashToSign)}`);
});

// Start message
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Welcome! Available commands:\n\n` +
      `/getaddr - Get your public address\n` +
      `/sign <hash> - Sign a 64-character hexadecimal hash`
  );
});
