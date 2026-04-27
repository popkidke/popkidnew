const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidDecode
} = require("@whiskeysockets/baileys");
const fs = require('fs');
const path = require('path');
const P = require('pino');
const { File } = require('megajs');
const config = require('./config');

// Global store for plugins
global.plugins = new Map();

/**
 * Decodes JID to a clean WhatsApp number
 */
const decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
        let decode = jidDecode(jid) || {};
        return decode.user && decode.server && decode.user + '@' + decode.server || jid;
    } else return jid;
};

async function startBot() {
    console.log("🛠️ Initializing " + config.BOT_NAME + "...");

    // 1. Session Authentication Logic
    const sessionPath = './sessions';
    const credsPath = path.join(sessionPath, 'creds.json');

    if (!fs.existsSync(credsPath)) {
        if (!config.SESSION_ID) {
            console.error('❌ ERROR: SESSION_ID is missing in config.js!');
            process.exit(1);
        }
        
        console.log("📦 Downloading Session from Mega...");
        try {
            const sessdata = config.SESSION_ID.replace("POPKID;;;", '');
            const filer = File.fromURL(`https://mega.nz/file/${sessdata}`);
            const data = await filer.downloadBuffer();
            
            if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
            fs.writeFileSync(credsPath, data);
            console.log("✅ Session downloaded and decrypted.");
        } catch (err) {
            console.error("❌ Failed to download session:", err.message);
            process.exit(1);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    // 2. Socket Configuration
    const sock = makeWASocket({
        version,
        logger: P({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Ultra-Engine", "Chrome", "1.0.0"],
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(
                message.buttonsMessage ||
                message.templateMessage ||
                message.listMessage
            );
            if (requiresPatch) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadata: {},
                                deviceListMetadataVersion: 2,
                            },
                            ...message,
                        },
                    },
                };
            }
            return message;
        },
    });

    // 3. Dynamic Plugin Loader
    const pluginFolder = path.join(__dirname, 'plugins');
    if (!fs.existsSync(pluginFolder)) fs.mkdirSync(pluginFolder);
    
    const files = fs.readdirSync(pluginFolder).filter(file => file.endsWith('.js'));
    for (const file of files) {
        try {
            const plugin = require(path.join(pluginFolder, file));
            global.plugins.set(plugin.name, plugin);
        } catch (e) {
            console.error(`❌ Error loading plugin ${file}:`, e);
        }
    }
    console.log(`📡 Network: ${global.plugins.size} external plugins active.`);

    sock.ev.on('creds.update', saveCreds);

    // 4. Connection Events & Private DM Notification
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`✨ Connected as: ${sock.user.name || 'Bot'}`);
            
            const myNumber = decodeJid(sock.user.id);
            const statusMsg = `🚀 *${config.BOT_NAME} IS ONLINE*\n\n` +
                              `✅ *Status:* Connected Successfully\n` +
                              `📅 *Date:* ${new Date().toLocaleDateString()}\n` +
                              `⏰ *Time:* ${new Date().toLocaleTimeString()}\n` +
                              `🧩 *Plugins:* ${global.plugins.size} Loaded\n` +
                              `⌨️ *Prefix:* [ ${config.PREFIX} ]\n\n` +
                              `_Type ${config.PREFIX}menu to begin._`;

            // Advanced "Eye-Catching" DM message
            await sock.sendMessage(myNumber, { 
                text: statusMsg,
                contextInfo: {
                    forwardingScore: 999,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                        newsletterJid: '120363423997837331@newsletter',
                        newsletterName: config.BOT_NAME,
                        serverMessageId: 1
                    },
                    externalAdReply: {
                        title: "SYSTEM NOTIFICATION",
                        body: config.BOT_NAME + " - Active",
                        thumbnailUrl: "https://telegra.ph/file/2026-status-icon.png", 
                        sourceUrl: "https://whatsapp.com",
                        mediaType: 1,
                        renderLargerThumbnail: true,
                        showAdAttribution: true
                    }
                }
            });
        }

        if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            console.log(`⚠️ Connection closed. Reason ID: ${reason}`);
            if (reason !== DisconnectReason.loggedOut) {
                console.log("♻️ Restarting session...");
                startBot();
            }
        }
    });

    // 5. Message Upsert (Command Handler)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        if (config.AUTO_READ) await sock.readMessages([m.key]);

        const from = m.key.remoteJid;
        const body = (m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || "");
        
        if (!body.startsWith(config.PREFIX)) return;

        const args = body.slice(config.PREFIX.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();

        // Match Command or Alias
        const plugin = Array.from(global.plugins.values()).find(p => 
            p.name === commandName || (p.alias && p.alias.includes(commandName))
        );

        if (plugin) {
            try {
                // Capture the original send function
                const originalSendMessage = sock.sendMessage;
                
                // Temporarily override to inject Newsletter metadata
                sock.sendMessage = async (jid, content, options = {}) => {
                    if (typeof content === 'object' && content !== null) {
                        content.contextInfo = {
                            ...(content.contextInfo || {}),
                            forwardingScore: 999,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363423997837331@newsletter',
                                newsletterName: config.BOT_NAME,
                                serverMessageId: 1
                            }
                        };
                    }
                    return originalSendMessage.apply(sock, [jid, content, options]);
                };

                await plugin.execute(sock, m, args);

                // Restore original function
                sock.sendMessage = originalSendMessage;

            } catch (err) {
                console.error("Plugin Error:", err);
                await sock.sendMessage(from, { text: "❌ Internal Plugin Error." });
            }
        }
    });
}

// Global error handling to keep the bot alive
process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

startBot();
