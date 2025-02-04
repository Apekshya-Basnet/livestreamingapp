const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { fakeComments, generateFakeComment } = require('./constants');
const geoip = require('geoip-lite');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:5173", "http://localhost:3000"],
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    path: '/socket.io/'
});

// Add security middleware
app.use(helmet()); // Adds various HTTP headers for security
app.use(xss()); // Sanitize inputs

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Add CORS options
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://r4mb4ww9-5173.inc1.devtunnels.ms',
  'https://r4mb4ww9-3001.inc1.devtunnels.ms'
];

const corsOptions = {
    origin: ["http://localhost:5173", "http://localhost:3000"],
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));

app.use(express.json());

// Authentication middleware
const authenticate = (req, res, next) => {
    const { username, password } = req.body;
    
    // Rate limiting for login attempts
    const ip = req.ip;
    const now = Date.now();
    loginAttempts.set(ip, (loginAttempts.get(ip) || 0) + 1);
    
    if (loginAttempts.get(ip) > 50) {
        return res.status(429).json({ message: 'Too many login attempts' });
    }

    // Compare with hardcoded credentials temporarily
    if (username === 'admin' && password === '12345') {
        next();
    } else {
        res.status(401).json({ message: 'Invalid credentials' });
    }
};

let activeViewers = new Map(); // { socketId: { username, ip, country } }
let streamActive = false;
const chatHistory = [];
const MAX_CHAT_HISTORY = 100;
let botInterval = null;
const BOT_DELAY_MIN = 3000;  // 5 seconds minimum
const BOT_DELAY_MAX = 10000; // 15 seconds maximum

const generateBotMessage = () => {
  const fakeComment = generateFakeComment();
  return {
    ...fakeComment,
    timestamp: new Date().toISOString(),
    id: Math.random().toString(36).substr(2, 9)
  };
};

// Admin route for streamer authentication
app.post('/admin/auth', authenticate, (req, res) => {
    res.json({ success: true });
});

const ADMIN_CREDENTIALS = {
    username: 'admin',
    password: '12345'
};

app.post('/api/admin/login', (req, res) => {
    console.log('Login attempt:', req.body); // Log the incoming request
    
    const { username, password } = req.body;
    
    // Check if username and password are provided
    if (!username || !password) {
        console.log('Missing credentials');
        return res.status(400).json({ 
            success: false, 
            message: 'Username and password are required' 
        });
    }

    // Check credentials
    if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
        console.log('Login successful');
        res.json({ success: true });
    } else {
        console.log('Login failed - Invalid credentials');
        res.status(401).json({ 
            success: false, 
            message: 'Invalid credentials' 
        });
    }
});

// Enhanced WebRTC configuration for cross-network compatibility
const iceServers = {
  iceServers: [
    // STUN servers for NAT traversal
    { 
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302'
      ]
    },
    // TURN servers for fallback when STUN fails
    {
      urls: [
        'turn:numb.viagenie.ca:3478',
        'turn:numb.viagenie.ca:3478?transport=tcp', // TCP fallback
        'turns:numb.viagenie.ca:443' // TURNS for TLS
      ],
      username: 'webrtc@live.com',
      credential: 'muazkh'
    }
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all', // Try both UDP and TCP
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// Enhanced peer connection options
const peerConnectionConfig = {
  enableDtlsSrtp: true, // Enable DTLS for secure communication
  sdpSemantics: 'unified-plan',
  iceServers: iceServers
};

// Add rate limiting for socket connections
const socketRateLimit = {
  messageCount: 0,
  lastReset: Date.now(),
  blocked: false
};

// Reset rate limit every minute
const resetInterval = setInterval(() => {
  socketRateLimit.messageCount = 0;
  socketRateLimit.lastReset = Date.now();
  socketRateLimit.blocked = false;
}, 60000);

// Bot message functionality
const BOT_MESSAGES = [
  'Hello, how are you?',
  'What\'s up?',
  'How\'s it going?',
  'Hi, I\'m a bot!',
  'What\'s on your mind?'
];

const startBotMessages = () => {
    if (botInterval) {
        clearInterval(botInterval);
    }

    const sendBotMessage = () => {
        const botMessage = generateFakeComment();
        const messageData = {
            ...botMessage,
            timestamp: new Date().toISOString(),
            id: Math.random().toString(36).substr(2, 9),
            isBot: true
        };

        chatHistory.push(messageData);
        if (chatHistory.length > MAX_CHAT_HISTORY) {
            chatHistory.shift();
        }

        io.emit('chat:message', messageData);
    };

    // Send first message after a short delay
    setTimeout(sendBotMessage, 2000);
    
    // Then send messages randomly between MIN and MAX delay
    botInterval = setInterval(() => {
        const delay = Math.floor(Math.random() * (BOT_DELAY_MAX - BOT_DELAY_MIN) + BOT_DELAY_MIN);
        setTimeout(sendBotMessage, delay);
    }, BOT_DELAY_MAX);
};

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('stream:start', () => {
        console.log('Admin started streaming:', socket.id);
        socket.join('admin-room');
        socket.to('viewer-room').emit('stream-available', { streamerId: socket.id });
        
        // Start bot messages when stream starts
        if (!botInterval) {
            startBotMessages();
        }
    });

    socket.on('stream:end', () => {
        streamActive = false;
        if (botInterval) {
            clearInterval(botInterval);
            botInterval = null;
        }
        socket.to('viewer-room').emit('stream-ended');
    });

    socket.on('viewer:join', (username) => {
        console.log('Viewer joined:', username);
        const ip = socket.handshake.address;
        const geo = geoip.lookup(ip) || { country: 'Unknown' };
        
        activeViewers.set(socket.id, {
            username,
            country: geo.country,
            ip: ip
        });

        socket.join('viewer-room');
        
        io.emit('viewers:update', {
            count: activeViewers.size,
            viewers: Array.from(activeViewers.values())
        });

        if (io.sockets.adapter.rooms.get('admin-room')?.size > 0) {
            const adminId = Array.from(io.sockets.adapter.rooms.get('admin-room'))[0];
            socket.emit('stream-available', { streamerId: adminId });
        }
    });

    socket.on('offer', ({ offer, streamerId }) => {
        console.log('Server received offer from viewer:', socket.id);
        console.log('Relaying offer to streamer:', streamerId);
        socket.to(streamerId).emit('offer', {
            offer,
            viewerId: socket.id
        });
    });

    socket.on('answer', ({ answer, viewerId }) => {
        console.log('Server received answer from streamer:', socket.id);
        console.log('Relaying answer to viewer:', viewerId);
        socket.to(viewerId).emit('answer', { answer });
    });

    socket.on('ice-candidate', ({ candidate, targetId }) => {
        console.log('Server relaying ICE candidate from:', socket.id, 'to:', targetId);
        socket.to(targetId).emit('ice-candidate', { candidate });
    });

    socket.on('chat:message', (messageData) => {
        try {
            const sanitizedMessage = {
                username: messageData.username,
                message: messageData.message,
                timestamp: new Date().toISOString(),
                id: messageData.id || Math.random().toString(36).substr(2, 9)
            };

            chatHistory.push(sanitizedMessage);
            if (chatHistory.length > MAX_CHAT_HISTORY) {
                chatHistory.shift();
            }

            io.emit('chat:message', sanitizedMessage);
        } catch (error) {
            console.error('Error handling chat message:', error);
        }
    });

    socket.on('chat:history', () => {
        socket.emit('chat:history', chatHistory);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        activeViewers.delete(socket.id);
        
        io.emit('viewers:update', {
            count: activeViewers.size,
            viewers: Array.from(activeViewers.values())
        });

        if (socket.rooms.has('admin-room')) {
            io.to('viewer-room').emit('stream-ended');
        }
    });
});

process.on('SIGINT', () => {
    if (botInterval) {
        clearInterval(botInterval);
    }
    process.exit();
});

// Add error handling for the server
server.on('error', (error) => {
    console.error('Server error:', error);
});

io.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Add a health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
});