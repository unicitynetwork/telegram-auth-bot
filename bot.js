const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { generateRecipientPubkeyAddr, getTxSigner, generateRandom256BitHex } = require("@unicitylabs/shared");
const { hash } = require("@unicitylabs/shared/hasher/sha256hasher.js").SHA256Hasher;
const { getHTTPTransport, defaultGateway, importFlow, exportFlow, getTokenStatus, mint } = require("@unicitylabs/tx-flow-engine");
require('dotenv').config();

const botToken = process.env.BOT_TOKEN;
const botSecret = process.env.BOT_SECRET;
const resolverUrl = process.env.RESOLVER_URL;
const telegramTXFGUI = process.env.WEB_URL;

if (!botToken) {
  console.error('Error: BOT_TOKEN not set in .env file');
  process.exit(1);
}

if (!botToken) {
  console.error('Error: BOT_SECRET not set in .env file');
  process.exit(1);
}

const bot = new TelegramBot(botToken, { polling: true });

let userStates = {}; // Temporary state to track user interactions

/**
 * Resolves a Telegram username or phone number to a userId by means of Telegram-helper-client.
 * @param {string} input - The username (e.g., "@exampleusername") or phone number (e.g., "+1234567890").
 * @returns {Promise<Object>} - A promise resolving to an object containing the userId and additional user details.
 * @throws {Error} - Throws an error if the resolution fails.
 */
async function resolveUserId(inp) {
/*  if (!inp.startsWith('@') && !inp.startsWith('+')) {
    throw new Error("Input must start with '@' (username) or '+' (phone number).");
  }*/

  try {
    const response = await axios.get(resolverUrl, {
      params: { request: inp }, // Pass the input as a query parameter
    });

    if (response.status === 200) {
      return response.data.userId; // { userId, username, firstName, lastName }
    } else {
      throw new Error(`Unexpected response status: ${response.status}`);
    }
  } catch (err) {
    console.error('Error calling the client:', err.message);
    throw new Error('Failed to resolve userId. Ensure the client is running and input is valid.');
  }
}

// Helper function to derive a secret from user ID
const deriveSecret = (userId) => {
  return hash(String(userId)+botSecret);
};

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.code, error.message);
});

// monitoring for TXF files
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (msg.document && msg.document.file_name.endsWith('.txf')) {
    const fileId = msg.document.file_id;

    try {
      // Download the file
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
      const fileResponse = await axios.get(fileUrl);

      const fileContent = fileResponse.data; // Assuming .txf is a JSON string
//    console.log(JSON.stringify(fileContent, null, 4));
      const token = await importFlow(JSON.stringify(fileContent));
      const transport = getHTTPTransport(defaultGateway());
      const secret = deriveSecret(msg.from.id);
      const status = await getTokenStatus(token, secret, transport);

      // Determine the token status
      let tokenStatus = 'NOT OWNED';
      let reply_keyboard = {};
      if(status.owned){
	tokenStatus = status.unspent?'SPENDABLE':'SPENT';
	// Save the token and file info for this user
        userStates[msg.from.id] = { token, fileId };
/*	if(status.unspent)
	 reply_keyboard = {
    	    reply_markup: {
        	inline_keyboard: [
        	    [{ text: 'Send', callback_data: `send:${fileId}` }],
        	],
    	    },
        };*/
      }

      // Send a message with the token status and a "Manage Token" button
      bot.sendMessage(chatId, `Token Status: ${tokenStatus}`, reply_keyboard);
    } catch (err) {
      console.error('Error processing the file:', err.message);
      bot.sendMessage(chatId, 'Failed to process the file. Please try again.');
    }
  }
});

// Step 2: Handle "Send" button press
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;

  if (callbackQuery.data.startsWith('send:')) {
    // Request destination username or phone
    bot.sendMessage(chatId, 'Please enter the destination username (e.g., @exampleusername) or phone number (e.g., +1234567890):', {
      reply_markup: { force_reply: true },
    });

    // Track state for this user
    userStates[userId].awaitingDestination = true;
  }
});

// Step 3: Handle destination input
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (userStates[userId]?.awaitingDestination) {
    const destination = msg.text.trim();
    delete userStates[userId].awaitingDestination;

    try {
      // Resolve the destination username or phone into a public address
      const destUserId = await resolveUserId(`${destination}`);
      const destinationAddress = generateRecipientPubkeyAddr(destUserId);

      // Modify the token file
      const { token } = userStates[userId];
      const transport = getHTTPTransport(defaultGateway());
      const secret = deriveSecret(msg.from.id);
      const salt = generateRandom256BitHex();

      const tx = await createTx(token, destinationAddress, salt, secret, transport);
/*      token.owner = destinationAddress;
      token.spent = true; // Mark as spent (example modification)
*/
//      const modifiedContent = JSON.stringify(token, null, 2);
      const modifiedContent = exportFlow(await importFlow(exportFlow(token, tx, true), deriveSecret(destUserId)));
      const modifiedFilePath = path.join(__dirname, 'modified.txf');
      fs.writeFileSync(modifiedFilePath, modifiedContent);

      // Re-upload the modified file
      await bot.sendDocument(chatId, modifiedFilePath, {
        caption: `Token sent to ${destination}. New owner: ${destinationAddress}`,
      });

      // Clean up temporary state and files
      delete userStates[userId];
      fs.unlinkSync(modifiedFilePath);
    } catch (err) {
      console.error('Error resolving destination or modifying the file:', err.message);
      bot.sendMessage(chatId, 'Failed to send the token. Please ensure the destination is valid.');
    }
  }
});


// Commands
bot.onText(/\/getaddr(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  let targetUserId;
  if (match[1]) {
    const input = match[1].trim();
    console.log("resolve request: "+input);
    // Check if it's a username or userId
    if (input.startsWith('@')) {
      const username = input.slice(1); // Remove '@'
      try {
        // Fetch user information using the username
        const chat = await bot.getChat(`@${username}`);
        targetUserId = chat.id; // Use the resolved userId
      } catch (err) {
	try{
	    targetUserId = await resolveUserId(`@${username}`);
	}catch(err){
    	    console.error('Error fetching user by username:', err);
    	    return bot.sendMessage(chatId, `Error: Unable to resolve username ${input}`);
	}
      }
    } else if (input.startsWith('+')) {
	const phonenum = input.slice(1); // Remove '+'
	try{
	    targetUserId = await resolveUserId(`+${phonenum}`);
	}catch(err){
    	    console.error('Error fetching user by phone number:', err);
    	    return bot.sendMessage(chatId, `Error: Unable to resolve username ${input}`);
	}
    }else if (/^\d+$/.test(input)) {
      // Treat it as a numeric userId
      targetUserId = parseInt(input, 10);
    } else {
      return bot.sendMessage(chatId, `Error: Invalid argument. Use @username, +phonenumber or numeric userId.`);
    }
  }

  const userId = targetUserId?targetUserId:msg.from.id;
  const secret = deriveSecret(userId);

  const address = generateRecipientPubkeyAddr(secret);
  console.log("userId: "+userId+", address: "+address);
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

bot.onText(/\/mint/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const secret = deriveSecret(userId);
  const transport = getHTTPTransport(defaultGateway());

  const token_id = generateRandom256BitHex();
  const token_class_id = 'aa226da0e61396b9c9ae55131600f3d836058048023af3fe807a9c8b35e11bad';
  const nonce = generateRandom256BitHex();
  const token_value = '1000000000000000000';
  const mint_salt = generateRandom256BitHex();
  const token = await mint({ 
    token_id, token_class_id, token_value, secret, nonce, mint_salt, sign_alg: 'secp256k1', hash_alg: 'sha256', transport
  });
  const fileContent = exportFlow(token, null, true);
  const filePath = path.join(__dirname, `${token_id}.txf`);

  fs.writeFileSync(filePath, fileContent);

  // Upload the .txf file
  await bot.sendDocument(chatId, filePath, {
        caption: `Token "${token_id}" minted successfully. Owner: ${userId}`,
  });
  fs.unlinkSync(filePath);
});

// Start message
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Welcome! Available commands:\n\n` +
      `/getaddr [<@userid|+phonenumber>]- Get your public address or public address for a user with @username or a +phonenumber\n` +
      `/sign <hash> - Sign a 64-character hexadecimal hash\n` +
      `/mint - mints new token for the caller`
  );
});
