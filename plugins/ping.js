module.exports = {
    name: "ping",
    alias: ["speed"],
    category: "main",
    async execute(sock, msg, args) {
        const start = Date.now();
        await sock.sendMessage(msg.key.remoteJid, { text: "🚀" }, { quoted: msg });
        await sock.sendMessage(msg.key.remoteJid, { text: `🚄 *Speed:* ${Date.now() - start}ms` }, { quoted: msg });
    }
};
