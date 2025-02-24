const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const twilio = require('twilio');
const cors = require('cors');
const path = require('path');
const { match } = require('assert');
require('dotenv').config();

const app = express();
let windowsPath;

// // Make sure STRIPE_SECRET_KEY exists
// if (!process.env.STRIPE_SECRET_KEY) {
//     throw new Error('STRIPE_SECRET_KEY is not defined in environment variables');
// }


// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const apiKeySid = process.env.TWILIO_API_KEY;
const apiKeySecret = process.env.TWILIO_API_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Initialize Twilio Client
const client = twilio(accountSid, authToken);

// Create HTTP server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients, rooms, and chat history
const clients = new Map();
const matches = new Map();
const activeRooms = new Map();
const chatHistory = new Map(); // Store chat history between pairs

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

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('New client connected');
    let userIdentity = null;

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            console.log('Received message:', message.type);

            switch(message.type) {
                case 'identify':
                    // Store client connection with user email
                    userIdentity = message.userId;
                    clients.set(message.userId, ws);
                    console.log(`User ${message.userId} identified`);
                    break;

                case 'chat':
                    handleChatMessage(message);
                    break;

                case 'join':
                    users.set(data.username, ws);
                    broadcastUsers();
                    break;

                case 'callUser':
                    handleCallUser(message, ws);
                    break;

                case 'room_status':
                    await handleRoomStatus(message);
                    break;

                case 'endCall':
                    handleEndCall(message);
                    break;

                case 'foundPartner':
                    // matches.set(message.partners, ws);
                    // console.log(message, "^&*%^", message.partners);
                    // message.partners.forEach((partner) => {
                    //     if(partner.)
                    // })
                    sendMessage = JSON.stringify({
                        type: 'foundMatch',
                        user1: message.partners[0],
                        user2: message.partners[1]
                    });
                    matches.set(data.partners, ws)
                    wss.clients.forEach(client => {
                        client.send(sendMessage);
                    })
                    // broadcastMatches();
                    break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        if (userIdentity) {
            clients.delete(userIdentity);
            // Cleanup any active rooms for this user
            cleanupUserRooms(userIdentity);
        }
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

// function broadcastMatches() {
//     const matchList = Array.from(matches.keys());
//     console.log(matchList, "@#@#@#@#");
//     wss.matches.forEach(match => {
//         if (match.readyState === WebSocket.OPEN) {
//             match.send(JSON.stringify({
//                 type: 'userList',
//                 users: matchList
//             }));
//         }
//     });
// }


// Chat Functions
function handleChatMessage(message) {
    const { from, to, message: content } = message;
    
    // Store in chat history
    const chatKey = [from, to].sort().join('_');
    if (!chatHistory.has(chatKey)) {
        chatHistory.set(chatKey, []);
    }
    chatHistory.get(chatKey).push({
        from,
        to,
        message: content,
        timestamp: new Date().toISOString()
    });

    // Send to recipient if online
    const recipientWs = clients.get(to);
    if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
        recipientWs.send(JSON.stringify(message));
    }
}

// Video Call Functions
async function handleCallUser(message, senderWs) {
    const targetUser = clients.get(message.target);
    if (targetUser && targetUser.readyState === WebSocket.OPEN) {
        const roomName = `room-${Date.now()}-${message.username}-${message.target}`;
        
        try {
            const room = await client.video.v1.rooms.create({
                uniqueName: roomName,
                type: 'group',
                maxParticipants: 2
            });

            activeRooms.set(roomName, {
                sid: room.sid,
                participants: [message.username, message.target]
            });

            targetUser.send(JSON.stringify({
                type: 'incomingCall',
                from: message.username,
                roomName: roomName,
                roomSid: room.sid
            }));

        } catch (error) {
            console.error('Error creating room:', error);
            senderWs.send(JSON.stringify({
                type: 'error',
                message: 'Failed to initiate call'
            }));
        }
    }
}

async function handleRoomStatus(message) {
    const { roomSid, status, participantIdentity } = message;
    try {
        const participants = await client.video.v1
            .rooms(roomSid)
            .participants
            .list();

        participants.forEach(participant => {
            const ws = clients.get(participant.identity);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'room_update',
                    roomSid,
                    status,
                    participant: participantIdentity
                }));
            }
        });
    } catch (error) {
        console.error('Error handling room status:', error);
    }
}

function handleEndCall(message) {
    const { roomName } = message;
    if (activeRooms.has(roomName)) {
        const room = activeRooms.get(roomName);
        room.participants.forEach(participant => {
            const ws = clients.get(participant);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'callEnded',
                    roomName: roomName
                }));
            }
        });
        activeRooms.delete(roomName);
    }
}

function cleanupUserRooms(userIdentity) {
    for (const [roomName, room] of activeRooms.entries()) {
        if (room.participants.includes(userIdentity)) {
            // Notify other participant
            const otherParticipant = room.participants.find(p => p !== userIdentity);
            if (otherParticipant) {
                const ws = clients.get(otherParticipant);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'participantDisconnected',
                        roomName: roomName
                    }));
                }
            }
            activeRooms.delete(roomName);
        }
    }
}

// app.post('/winDir', (req, res) => {
//     localStorage.setItem("winDir", req.body.winDir);
// })

// API Routes
app.post('/generate-token', async (req, res) => {
    try {
        const { identity, roomName } = req.body;
        
        if (!identity || !roomName) {
            return res.status(400).json({ 
                error: 'Both identity and roomName are required' 
            });
        }

        const token = new twilio.jwt.AccessToken(
            accountSid,
            apiKeySid,
            apiKeySecret,
            { identity: identity }
        );

        const videoGrant = new twilio.jwt.AccessToken.VideoGrant({
            room: roomName
        });
        token.addGrant(videoGrant);
        
        console.log(`Generated token for ${identity} in room ${roomName}`);
        res.json({ token: token.toJwt() });
    } catch (error) {
        console.error('Error generating token:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/create-room', async (req, res) => {
    try {
        const { roomName } = req.body;
        
        const room = await client.video.v1.rooms.create({
            uniqueName: roomName,
            type: 'group',
            maxParticipants: 2
        });

        console.log("Created room:", room.sid);
        res.json({ roomSid: room.sid });
    } catch (error) {
        console.error('Error creating room:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get chat history between two users
app.get('/chat-history', (req, res) => {
    const { user1, user2 } = req.query;
    if (!user1 || !user2) {
        return res.status(400).json({ error: 'Both users must be specified' });
    }

    const chatKey = [user1, user2].sort().join('_');
    const history = chatHistory.get(chatKey) || [];
    res.json({ messages: history });
});

// Serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/process-payment', async (req, res) => {
    try {
        const { token, amount, currency = 'usd' } = req.body;

        // Create a customer
        const customer = await stripe.customers.create({
            source: token.id,
            email: token.email
        });

        // Create a charge
        const charge = await stripe.charges.create({
            amount: amount,
            currency: currency,
            customer: customer.id,
            description: 'Premium Plan Subscription',
            shipping: {
                name: token.card.name,
                address: {
                    line1: token.card.address_line1,
                    city: token.card.address_city,
                    state: token.card.address_state,
                    postal_code: token.card.address_zip
                }
            }
        });

        res.json({
            success: true,
            charge: charge
        });
    } catch (error) {
        console.error('Payment processing error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Create subscription with token
app.post('/create-subscription', async (req, res) => {
    try {
        const { token, plan, email } = req.body;

        // Create a customer
        const customer = await stripe.customers.create({
            email: email,
            source: token.id
        });

        // Create subscription
        const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: plan }],
            expand: ['latest_invoice.payment_intent']
        });

        res.json({
            success: true,
            subscription: subscription
        });
    } catch (error) {
        console.error('Subscription error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/create-payment-session', async (req, res) => {
    try {
        const { plan, email } = req.body;

        // Define plan prices
        const prices = {
            basic: {
                amount: 999, // $9.99
                name: 'Basic Plan'
            },
            premium: {
                amount: 1999, // $19.99
                name: 'Premium Plan'
            }
        };

        const selectedPlan = prices[plan];
        if (!selectedPlan) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        // Create Stripe session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: selectedPlan.name,
                        description: `Monthly subscription to ${selectedPlan.name}`,
                    },
                    unit_amount: selectedPlan.amount,
                    recurring: {
                        interval: 'month',
                    },
                },
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${req.headers.origin}/?payment_status=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin}/?payment_status=cancelled`,
            customer_email: email,
        });

        res.json({ 
            sessionId: session.id,
            paymentUrl: session.url 
        });
    } catch (error) {
        console.error('Error creating payment session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Verify payment status
app.post('/verify-payment', async (req, res) => {
    try {
        const { sessionId } = req.body;

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            // Update user's subscription status in your database
            // For now, we'll just return success
            res.json({
                success: true,
                expiryDate: new Date(session.subscription.current_period_end * 1000).toISOString(),
                plan: session.metadata.plan
            });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ error: error.message });
    }
});

// Handle Stripe webhooks
app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // Verify webhook signature
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle specific webhook events
    switch (event.type) {
        case 'customer.subscription.created':
            await handleSubscriptionCreated(event.data.object);
            break;
        case 'customer.subscription.updated':
            await handleSubscriptionUpdated(event.data.object);
            break;
        case 'customer.subscription.deleted':
            await handleSubscriptionCancelled(event.data.object);
            break;
        case 'invoice.payment_failed':
            await handlePaymentFailed(event.data.object);
            break;
    }

    res.json({received: true});
});

// Subscription event handlers
async function handleSubscriptionCreated(subscription) {
    const customer = await stripe.customers.retrieve(subscription.customer);
    const userEmail = customer.email;
    
    // Notify the user through WebSocket if they're connected
    const userWs = clients.get(userEmail);
    if (userWs && userWs.readyState === WebSocket.OPEN) {
        userWs.send(JSON.stringify({
            type: 'subscription_update',
            status: 'active',
            plan: subscription.metadata.plan,
            expiryDate: new Date(subscription.current_period_end * 1000).toISOString()
        }));
    }
}

async function handleSubscriptionUpdated(subscription) {
    const customer = await stripe.customers.retrieve(subscription.customer);
    const userEmail = customer.email;
    
    // Notify user of subscription update
    const userWs = clients.get(userEmail);
    if (userWs && userWs.readyState === WebSocket.OPEN) {
        userWs.send(JSON.stringify({
            type: 'subscription_update',
            status: subscription.status,
            plan: subscription.metadata.plan,
            expiryDate: new Date(subscription.current_period_end * 1000).toISOString()
        }));
    }
}

async function handleSubscriptionCancelled(subscription) {
    const customer = await stripe.customers.retrieve(subscription.customer);
    const userEmail = customer.email;
    
    // Notify user of cancellation
    const userWs = clients.get(userEmail);
    if (userWs && userWs.readyState === WebSocket.OPEN) {
        userWs.send(JSON.stringify({
            type: 'subscription_update',
            status: 'cancelled',
            message: 'Your subscription has been cancelled'
        }));
    }
}

async function handlePaymentFailed(invoice) {
    const customer = await stripe.customers.retrieve(invoice.customer);
    const userEmail = customer.email;
    
    // Notify user of payment failure
    const userWs = clients.get(userEmail);
    if (userWs && userWs.readyState === WebSocket.OPEN) {
        userWs.send(JSON.stringify({
            type: 'payment_failed',
            message: 'Your payment has failed. Please update your payment method.'
        }));
    }
}

// Start server
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});