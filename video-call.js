// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize Twilio Client
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Serve static files
app.use(express.static('public'));

// Generate Twilio token
app.get('/token', async (req, res) => {
    try {
        const videoGrant = new twilio.jwt.AccessToken.VideoGrant();
        const token = new twilio.jwt.AccessToken(
            process.env.TWILIO_ACCOUNT_SID,
            process.env.TWILIO_API_KEY,
            process.env.TWILIO_API_SECRET,
            { identity: req.query.username }
        );

        token.addGrant(videoGrant);
        res.json({ token: token.toJwt() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Store connected users
const users = new Map();

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        switch(data.type) {
            case 'join':
                users.set(data.username, ws);
                broadcastUsers();
                break;
                
            case 'callUser':
                const targetUser = users.get(data.target);
                if (targetUser) {
                    targetUser.send(JSON.stringify({
                        type: 'incomingCall',
                        from: data.username,
                        roomName: data.roomName
                    }));
                }
                break;
        }
    });

    ws.on('close', () => {
        for (let [username, userWs] of users.entries()) {
            if (userWs === ws) {
                users.delete(username);
                break;
            }
        }
        broadcastUsers();
    });
});

function broadcastUsers() {
    const userList = Array.from(users.keys());
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'userList',
                users: userList
            }));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});