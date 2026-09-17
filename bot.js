const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');
const app = express();
const PORT = 8080; // Hardcoded for Fly.io


const TOKEN = '8236093600:AAGbegOvkaZQiqIsO8dX726-Hs0od8Ee0Z4';
const bot = new TelegramBot(TOKEN, { polling: true });
const DB_FILE = './database.json';

let db = { games: {}, users: {} };
const turnTimers = {};
const afkTimers = {};

// ============================================================
// DATABASE (Debounced & Async to prevent file corruption)
// ============================================================
let isSaving = false;
let pendingSave = false;

app.get('/', (req, res) => {
    res.send('Truth or Dare Bot is healthy and running!');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dummy health-check server running on port ${PORT}`);
});

function loadDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            saveDB();
            return;
        }
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (data && typeof data === 'object' && data.games && typeof data.games === 'object' && data.users && typeof data.users === 'object') {
            db = data;
        } else {
            console.log('Invalid database structure. Using empty database.');
            db = { games: {}, users: {} };
        }
    } catch (err) {
        console.error('Error loading database:', err);
        db = { games: {}, users: {} };
    }
}

function saveDB() {
    if (isSaving) {
        pendingSave = true; 
        return;
    }
    isSaving = true;
    fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), (err) => {
        if (err) console.error('Error saving database:', err);
        isSaving = false;
        if (pendingSave) {
            pendingSave = false;
            saveDB();
        }
    });
}
loadDB();

// ============================================================
// HELPERS
// ============================================================
function escapeHTML(text) {
    if (!text) return "";
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const handleEditError = (err) => {
    if (err.message && !err.message.includes("is not modified")) {
        console.error("Edit message error:", err.message);
    }
};

function clearTurnTimer(chatId) {
    if (turnTimers[chatId]) {
        clearTimeout(turnTimers[chatId]);
        delete turnTimers[chatId];
    }
    if (afkTimers[chatId]) {
        clearTimeout(afkTimers[chatId]);
        delete afkTimers[chatId];
    }
}

function normalizeTurnIndex(game) {
    if (!game || !Array.isArray(game.players)) return;
    if (game.players.length === 0) {
        game.turnIndex = 0;
        return;
    }
    if (typeof game.turnIndex !== 'number' || !Number.isInteger(game.turnIndex)) {
        game.turnIndex = 0;
    }
    game.turnIndex = ((game.turnIndex % game.players.length) + game.players.length) % game.players.length;
}

function scheduleNextTurn(chatId, delay = 2000) {
    clearTurnTimer(chatId);
    turnTimers[chatId] = setTimeout(() => {
        delete turnTimers[chatId];
        const game = db.games[chatId];
        if (!game || game.status !== 'started' || game.players.length < 3) return;
        nextTurn(chatId);
    }, delay);
}

function removeUserFromGroup(userId, chatId) {
    const user = db.users[userId];
    if (!user) return;
    if (Array.isArray(user.groups)) {
        user.groups = user.groups.filter(id => String(id) !== String(chatId));
    }
    if ((!user.groups || user.groups.length === 0) && !user.pendingQ) {
        delete db.users[userId];
    }
}

function cleanupGameUsers(game, chatId) {
    if (!game || !Array.isArray(game.players)) return;
    for (const player of game.players) removeUserFromGroup(player.id, chatId);
}

const defaultTruths = [
    'What is your biggest fear?', 'What is your most embarrassing moment?', 
    'Who was your first crush?', 'What is one secret you have never told anyone?'
];
const defaultDares = [
    'Send a funny selfie to the group.', 'Do 10 push-ups.', 
    'Sing a song for 20 seconds.', 'Change your profile picture for 10 minutes.'
];

for (const chatId of Object.keys(db.games)) {
    const game = db.games[chatId];
    if (game && game.status === 'started' && game.phase === 'idle' && game.players && game.players.length >= 3) {
        scheduleNextTurn(chatId, 2000);
    }
}

// ============================================================
// COMMANDS
// ============================================================
bot.onText(/^\/join(?:@[A-Za-z0-9_]+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (msg.chat.type === 'private') return bot.sendMessage(chatId, '❌ /join can only be used inside a group.');

    let game = db.games[chatId];
    if (!game) {
        game = {
            status: 'waiting', phase: 'idle', players: [], turnIndex: 0,
            customTruths: [], customDares: [], currentMessageId: null,
            currentQuestionType: null, currentQuestionText: null,
            changeVotes: [], verifyVotes: [], hasChanged: false
        };
        db.games[chatId] = game;
    }

    if (game.players.some(player => String(player.id) === String(userId))) {
        return bot.sendMessage(chatId, '⚠️ You are already in the game.');
    }

    game.players.push({
        id: userId,
        name: msg.from.first_name || msg.from.username || `Player ${userId}`
    });

    if (!db.users[userId]) db.users[userId] = { groups: [], pendingQ: null };
    if (!Array.isArray(db.users[userId].groups)) db.users[userId].groups = [];
    if (!db.users[userId].groups.includes(chatId)) db.users[userId].groups.push(chatId);
    saveDB();

    await bot.sendMessage(chatId, `✅ ${escapeHTML(msg.from.first_name)} joined the game!\n\nPlayers: ${game.players.length}`, {parse_mode: 'HTML'});

    try {
        await bot.sendMessage(userId, 'You joined the Truth or Dare game. 🎭\nTo add questions, use:\n`/truth your question`\n`/dare your dare`', { parse_mode: 'Markdown' });
    } catch (err) { }
});

bot.onText(/^\/leave(?:@[A-Za-z0-9_]+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const game = db.games[chatId];

    if (!game) return bot.sendMessage(chatId, '❌ No game is running.');

    const playerIndex = game.players.findIndex(player => String(player.id) === String(userId));
    if (playerIndex === -1) return bot.sendMessage(chatId, '❌ You are not in this game.');

    const wasCurrentPlayer = playerIndex === game.turnIndex;
    if (playerIndex < game.turnIndex) game.turnIndex--;

    game.players.splice(playerIndex, 1);
    removeUserFromGroup(userId, chatId);

    if (game.players.length === 0) {
        clearTurnTimer(chatId);
        delete db.games[chatId];
        saveDB();
        return bot.sendMessage(chatId, '👋 Game ended because everyone left.');
    }
    normalizeTurnIndex(game);

    if (game.status === 'started' && game.players.length < 3) {
        clearTurnTimer(chatId);
        game.phase = 'idle';
        game.changeVotes = [];
        game.verifyVotes = [];
        game.currentMessageId = null;
        saveDB();
        return bot.sendMessage(chatId, `👋 ${escapeHTML(msg.from.first_name)} left.\n⚠️ Game paused because at least 3 players are required.`, {parse_mode: 'HTML'});
    }

    saveDB();
    await bot.sendMessage(chatId, `👋 ${escapeHTML(msg.from.first_name)} left the game.\n\nPlayers remaining: ${game.players.length}`, {parse_mode: 'HTML'});

    if (game.status === 'started' && game.players.length >= 3 && wasCurrentPlayer) {
        game.phase = 'idle';
        game.changeVotes = [];
        game.verifyVotes = [];
        game.currentMessageId = null;
        saveDB();
        await askTruthOrDare(chatId);
    }
});

bot.onText(/^\/stopgame(?:@[A-Za-z0-9_]+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const game = db.games[chatId];
    if (!game) return bot.sendMessage(chatId, '❌ No game is running.');
    if (!game.players.some(player => String(player.id) === String(msg.from.id))) {
        return bot.sendMessage(chatId, '❌ Only players can stop the game.');
    }
    clearTurnTimer(chatId);
    cleanupGameUsers(game, chatId);
    delete db.games[chatId];
    saveDB();
    await bot.sendMessage(chatId, '🛑 Game stopped successfully.');
});

bot.onText(/^\/startgame(?:@[A-Za-z0-9_]+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const game = db.games[chatId];
    if (!game) return bot.sendMessage(chatId, '❌ No game exists. Use /join first.');
    if (game.status === 'started') return bot.sendMessage(chatId, '⚠️ Game has already started.');
    if (!game.players.some(player => String(player.id) === String(msg.from.id))) {
        return bot.sendMessage(chatId, '❌ You must join the game first.');
    }
    if (game.players.length < 3) return bot.sendMessage(chatId, '❌ At least 3 players are required to start.');

    clearTurnTimer(chatId);
    game.status = 'started';
    game.phase = 'idle';
    game.turnIndex = 0;
    game.changeVotes = [];
    game.verifyVotes = [];
    game.currentMessageId = null;
    saveDB();
    await askTruthOrDare(chatId);
});

bot.onText(/^\/skip(?:@[A-Za-z0-9_]+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const game = db.games[chatId];
    if (!game || game.status !== 'started') return;
    if (!game.players.some(p => String(p.id) === String(msg.from.id))) {
        return bot.sendMessage(chatId, "❌ Only active players can skip turns.");
    }
    clearTurnTimer(chatId);
    await bot.sendMessage(chatId, "⏭️ Turn skipped!");
    nextTurn(chatId);
});

bot.onText(/^\/(truth|dare)(?:@[A-Za-z0-9_]+)?\s+(.+)$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const type = match[1].toLowerCase();
    const question = match[2].trim();

    if (msg.chat.type !== 'private') return bot.sendMessage(chatId, '❌ Please send custom questions to me in private chat.');
    if (!question) return;

    const user = db.users[userId];
    if (!user || !Array.isArray(user.groups)) return bot.sendMessage(chatId, '❌ You are not currently in any game.');

    const groups = user.groups.filter(id => db.games[id]);
    if (groups.length === 0) return bot.sendMessage(chatId, '❌ You are not currently in any active game.');

    if (groups.length === 1) {
        addCustomQuestion(groups[0], type, question, userId);
        return bot.sendMessage(chatId, `✅ ${type.toUpperCase()} added to your game.`);
    }

    user.pendingQ = { type, text: question };
    const buttons = groups.map(groupId => {
        const game = db.games[groupId];
        return [{ text: `Add to ${game?.name || 'this group'}`, callback_data: `selgrp_${groupId}` }];
    });
    await bot.sendMessage(chatId, 'Choose which game should receive this question:', { reply_markup: { inline_keyboard: buttons } });
});

// ============================================================
// CORE LOGIC 
// ============================================================
function addCustomQuestion(chatId, type, question, userId) {
    const game = db.games[chatId];
    if (!game) return false;
    if (!Array.isArray(game.customTruths)) game.customTruths = [];
    if (!Array.isArray(game.customDares)) game.customDares = [];

    const item = { text: question, authorId: userId };
    if (type === 'truth') game.customTruths.push(item);
    else game.customDares.push(item);
    saveDB();
    return true;
}

function getRandomQuestion(game, type) {
    const extractText = (q) => (typeof q === 'string' ? q : q.text);
    
    let pool = type === 'truth' 
        ? [...defaultTruths, ...(Array.isArray(game.customTruths) ? game.customTruths.map(extractText) : [])]
        : [...defaultDares, ...(Array.isArray(game.customDares) ? game.customDares.map(extractText) : [])];

    if (pool.length === 0) return 'No question available.';
    let question = pool[Math.floor(Math.random() * pool.length)];

    if (pool.length > 1 && game.currentQuestionText && question === game.currentQuestionText) {
        const alternatives = pool.filter(q => q !== game.currentQuestionText);
        question = alternatives[Math.floor(Math.random() * alternatives.length)];
    }
    return question;
}

async function askTruthOrDare(chatId) {
    const game = db.games[chatId];
    if (!game || game.status !== 'started' || !Array.isArray(game.players) || game.players.length < 3) return;

    clearTurnTimer(chatId);
    normalizeTurnIndex(game);
    const currentPlayer = game.players[game.turnIndex];
    if (!currentPlayer) return;

    game.phase = 'picking';
    game.changeVotes = [];
    game.verifyVotes = [];
    game.hasChanged = false;
    game.currentQuestionType = null;
    game.currentQuestionText = null;
    game.currentMessageId = null;
    saveDB();

    const safeName = escapeHTML(currentPlayer.name);
    const text = `🎯 Turn: <a href="tg://user?id=${currentPlayer.id}">${safeName}</a>\n\nChoose Truth or Dare:`;

    try {
        const sent = await bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🟢 Truth', callback_data: 'pick_truth' }, { text: '🔴 Dare', callback_data: 'pick_dare' }]
                ]
            }
        });
        if (!db.games[chatId]) return;
        game.currentMessageId = sent.message_id;
        
        // AFK 60-second auto-skip timer
        afkTimers[chatId] = setTimeout(() => {
            if (db.games[chatId] && db.games[chatId].phase === 'picking') {
                bot.sendMessage(chatId, `⏳ Time's up! Skipping ${safeName}'s turn...`, {parse_mode: 'HTML'});
                nextTurn(chatId);
            }
        }, 60000);
        
        saveDB();
    } catch (err) {
        console.error('Error sending Truth/Dare message:', err);
    }
}

async function nextTurn(chatId) {
    const game = db.games[chatId];
    if (!game || game.status !== 'started' || game.players.length < 3) return;
    clearTurnTimer(chatId);
    game.turnIndex++;
    normalizeTurnIndex(game);
    game.phase = 'idle';
    game.changeVotes = [];
    game.verifyVotes = [];
    game.currentMessageId = null;
    saveDB();
    await askTruthOrDare(chatId);
}

// ============================================================
// CALLBACK QUERIES
// ============================================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const action = query.data;

    if (action.startsWith('selgrp_')) {
        const groupId = action.split('_')[1];
        const user = db.users[userId];
        if (user && user.pendingQ) {
            const targetGame = db.games[groupId];
            if (!targetGame || !targetGame.players.some(p => String(p.id) === String(userId))) {
                bot.editMessageText("❌ You are no longer in this game!", { chat_id: chatId, message_id: query.message.message_id }).catch(handleEditError);
                return bot.answerCallbackQuery(query.id);
            }
            addCustomQuestion(groupId, user.pendingQ.type, user.pendingQ.text, userId);
            const savedType = user.pendingQ.type;
            user.pendingQ = null;
            saveDB();
            bot.editMessageText(`✅ ${savedType.toUpperCase()} added to the game!`, { chat_id: chatId, message_id: query.message.message_id }).catch(handleEditError);
        }
        return bot.answerCallbackQuery(query.id);
    }

    const game = db.games[chatId];
    if (!game) return bot.answerCallbackQuery(query.id);

    if (game.status !== 'started') {
        return bot.answerCallbackQuery(query.id, { text: "Game is currently paused.", show_alert: true });
    }
    if (query.message.message_id !== game.currentMessageId) {
        return bot.answerCallbackQuery(query.id, { text: "This button is expired!", show_alert: true });
    }

    normalizeTurnIndex(game);
    const currentPlayer = game.players[game.turnIndex];
    if (!game.players.some(p => String(p.id) === String(userId))) {
        return bot.answerCallbackQuery(query.id, { text: "You aren't playing in this game!", show_alert: true });
    }

    const safeName = escapeHTML(currentPlayer.name);
    const requiredVotes = Math.max(1, Math.ceil((game.players.length - 1) / 2)); // Dynamic votes

    // 1. Pick Truth/Dare
    if (action === 'pick_truth' || action === 'pick_dare') {
        if (game.phase !== 'picking') return bot.answerCallbackQuery(query.id);
        if (String(userId) !== String(currentPlayer.id)) return bot.answerCallbackQuery(query.id, { text: "Not your turn!", show_alert: true });

        clearTurnTimer(chatId); // Clear AFK timer
        game.phase = 'action';
        game.currentQuestionType = action === 'pick_truth' ? 'truth' : 'dare';
        game.currentQuestionText = getRandomQuestion(game, game.currentQuestionType);
        saveDB();

        const safeQuestion = escapeHTML(game.currentQuestionText);
        bot.editMessageText(`<b>${game.currentQuestionType.toUpperCase()}</b> for ${safeName}:\n\n"${safeQuestion}"`, {
            chat_id: chatId, message_id: game.currentMessageId, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🔄 Request Change", callback_data: "req_change" }], [{ text: "✅ Done (Verify)", callback_data: "req_verify" }]] }
        }).catch(handleEditError);
        return bot.answerCallbackQuery(query.id);
    }

    // 2. Request Change
    if (action === 'req_change') {
        if (game.phase !== 'action') return bot.answerCallbackQuery(query.id);
        if (String(userId) !== String(currentPlayer.id)) return bot.answerCallbackQuery(query.id, { text: "Only the active player can request.", show_alert: true });
        
        game.phase = 'change_vote';
        saveDB();

        bot.sendMessage(chatId, `${safeName} wants to change. ${requiredVotes} OTHER players must agree!`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: `👍 Allow Change (0/${requiredVotes})`, callback_data: "vote_change" }], [{ text: "❌ Cancel Request", callback_data: "cancel_req" }]] }
        }).then(sentMsg => {
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: game.currentMessageId }).catch(handleEditError);
            game.currentMessageId = sentMsg.message_id;
            saveDB();
        }).catch(err => console.error(err));
        return bot.answerCallbackQuery(query.id);
    }

    // 3. Vote Change
    if (action === 'vote_change') {
        if (game.phase !== 'change_vote') return bot.answerCallbackQuery(query.id);
        if (String(userId) === String(currentPlayer.id)) return bot.answerCallbackQuery(query.id, { text: "You can't vote for yourself!", show_alert: true });
        if (game.changeVotes.includes(String(userId))) return bot.answerCallbackQuery(query.id, { text: "You already voted!", show_alert: true });

        game.changeVotes.push(String(userId));
        
        if (game.changeVotes.length >= requiredVotes) {
            game.phase = 'action'; 
            game.hasChanged = true; // Prevent infinite changes
            game.currentQuestionText = getRandomQuestion(game, game.currentQuestionType);
            game.changeVotes = [];
            
            const safeQuestion = escapeHTML(game.currentQuestionText);
            bot.editMessageText(`✅ Change approved! \n\n🔄 <b>NEW ${game.currentQuestionType.toUpperCase()}</b> for ${safeName}:\n\n"${safeQuestion}"`, { 
                chat_id: chatId, message_id: game.currentMessageId, parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "✅ Done (Verify)", callback_data: "req_verify" }]] }
            }).catch(handleEditError);
        } else {
            bot.editMessageReplyMarkup({ inline_keyboard: [
                [{ text: `👍 Allow Change (${game.changeVotes.length}/${requiredVotes})`, callback_data: "vote_change" }],
                [{ text: "❌ Cancel Request", callback_data: "cancel_req" }]
            ]}, { chat_id: chatId, message_id: game.currentMessageId }).catch(handleEditError);
        }
        saveDB();
        return bot.answerCallbackQuery(query.id);
    }

    // 4. Request Verify
    if (action === 'req_verify') {
        if (game.phase !== 'action') return bot.answerCallbackQuery(query.id);
        if (String(userId) !== String(currentPlayer.id)) return bot.answerCallbackQuery(query.id, { text: "Not your turn!", show_alert: true });

        game.phase = 'verify_vote';
        saveDB();

        bot.sendMessage(chatId, `Did ${safeName} complete it? Need ${requiredVotes} OTHER players to verify.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: `✅ Yes, they did it! (0/${requiredVotes})`, callback_data: "vote_verify" }], [{ text: "❌ Cancel Request", callback_data: "cancel_req" }]] }
        }).then(sentMsg => {
            bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: game.currentMessageId }).catch(handleEditError);
            game.currentMessageId = sentMsg.message_id;
            saveDB();
        }).catch(err => console.error(err));
        return bot.answerCallbackQuery(query.id);
    }

    // 5. Vote Verify
    if (action === 'vote_verify') {
        if (game.phase !== 'verify_vote') return bot.answerCallbackQuery(query.id);
        if (String(userId) === String(currentPlayer.id)) return bot.answerCallbackQuery(query.id, { text: "You can't verify yourself!", show_alert: true });
        if (game.verifyVotes.includes(String(userId))) return bot.answerCallbackQuery(query.id, { text: "You already verified!", show_alert: true });

        game.verifyVotes.push(String(userId));

        if (game.verifyVotes.length >= requiredVotes) {
            game.phase = 'idle'; 
            bot.editMessageText(`✅ Task verified by the group! Moving to next turn...`, { chat_id: chatId, message_id: game.currentMessageId }).catch(handleEditError);
            scheduleNextTurn(chatId, 2000); 
        } else {
            bot.editMessageReplyMarkup({ inline_keyboard: [
                [{ text: `✅ Yes, they did it! (${game.verifyVotes.length}/${requiredVotes})`, callback_data: "vote_verify" }],
                [{ text: "❌ Cancel Request", callback_data: "cancel_req" }]
            ]}, { chat_id: chatId, message_id: game.currentMessageId }).catch(handleEditError);
        }
        saveDB();
        return bot.answerCallbackQuery(query.id);
    }

    // 6. Cancel Request
    if (action === 'cancel_req') {
        if (game.phase !== 'change_vote' && game.phase !== 'verify_vote') return bot.answerCallbackQuery(query.id);
        if (String(userId) !== String(currentPlayer.id)) return bot.answerCallbackQuery(query.id, { text: "Only the active player can cancel.", show_alert: true });
        
        game.phase = 'action';
        game.changeVotes = [];
        game.verifyVotes = [];
        saveDB();

        const safeQuestion = escapeHTML(game.currentQuestionText);
        const keyboard = [];
        if (!game.hasChanged) keyboard.push([{ text: "🔄 Request Change", callback_data: "req_change" }]);
        keyboard.push([{ text: "✅ Done (Verify)", callback_data: "req_verify" }]);

        bot.editMessageText(`<b>${game.currentQuestionType.toUpperCase()}</b> for ${safeName}:\n\n"${safeQuestion}"`, {
            chat_id: chatId, message_id: game.currentMessageId, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(handleEditError);
        return bot.answerCallbackQuery(query.id, { text: "Request cancelled." });
    }
});

console.log('Bot is running securely and perfectly tuned!');