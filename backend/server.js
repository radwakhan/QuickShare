const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { randomUUID } = require("crypto");

const app = express();

// ------------------------------------
// CONFIGURATION
// ------------------------------------

const PORT = process.env.PORT || 3000;

const allowedOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    process.env.FRONTEND_URL
].filter(Boolean);

// CORS configuration
const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests without an Origin header (such as health checks).
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    methods: ["GET", "POST"]
};

app.use(cors(corsOptions));
app.use(express.json());

// ------------------------------------
// CREATE HTTP SERVER
// ------------------------------------

const httpServer = http.createServer(app);

// ------------------------------------
// SOCKET.IO CONFIGURATION
// ------------------------------------

const io = new Server(httpServer, {
    cors: corsOptions
});

// Store active sharing sessions
const sessions = new Map();

// ------------------------------------
// HEALTH CHECK API
// ------------------------------------

app.get("/api/health", (req, res) => {
    res.json({
        message: "QuickShare backend is running!",
        status: "success"
    });
});

// ------------------------------------
// SOCKET.IO CONNECTION
// ------------------------------------

io.on("connection", (socket) => {

    console.log("Device connected:", socket.id);

    // --------------------------------
    // CREATE SHARING SESSION
    // --------------------------------

    socket.on("create-session", (callback) => {

        if (typeof callback !== "function") {
            return;
        }

        const sessionId = randomUUID();

        const expiresAt = Date.now() + 15 * 60 * 1000;

        sessions.set(sessionId, {
            hostId: socket.id,
            expiresAt
        });

        socket.join(sessionId);

        console.log("Session created:", sessionId);

        callback({
            success: true,
            sessionId,
            expiresAt
        });

        // Automatically expire session after 15 minutes
        setTimeout(() => {

            const session = sessions.get(sessionId);

            if (session && session.expiresAt <= Date.now()) {

                io.to(sessionId).emit("session-expired");

                sessions.delete(sessionId);

                console.log("Session expired:", sessionId);
            }

        }, 15 * 60 * 1000);

    });

    // --------------------------------
    // JOIN EXISTING SESSION
    // --------------------------------

    socket.on("join-session", (sessionId, callback) => {

        if (typeof callback !== "function") {
            return;
        }

        const session = sessions.get(sessionId);

        if (!session || session.expiresAt <= Date.now()) {

            callback({
                success: false,
                message: "Session does not exist or has expired."
            });

            return;
        }

        socket.join(sessionId);

        console.log("Device joined session:", sessionId);

        callback({
            success: true,
            message: "Joined successfully!"
        });

        // Notify laptop that phone has joined
        io.to(session.hostId).emit("peer-joined", {
            peerId: socket.id
        });

    });

    // --------------------------------
    // WEBRTC SIGNALING
    // --------------------------------

    socket.on("signal", (data) => {

        console.log("\nSignal received from:", socket.id);

        if (!data || !data.sessionId || !data.signal) {

            console.log("Invalid signaling data");

            return;
        }

        const session = sessions.get(data.sessionId);

        if (!session || session.expiresAt <= Date.now()) {

            console.log("Session invalid or expired");

            return;
        }

        // Verify device belongs to this session
        if (!socket.rooms.has(data.sessionId)) {

            console.log("Unauthorized signaling attempt");

            return;
        }

        console.log("Session ID:", data.sessionId);

        console.log(
            "Signal type:",
            data.signal.type || "ICE candidate"
        );

        // Forward signal to the other device
        socket.to(data.sessionId).emit("signal", {
            signal: data.signal,
            senderId: socket.id
        });

        console.log("Signal forwarded successfully!");

    });

    // --------------------------------
    // HANDLE DISCONNECTION
    // --------------------------------

    socket.on("disconnect", () => {

        console.log("Device disconnected:", socket.id);

        for (const [sessionId, session] of sessions.entries()) {

            if (session.hostId === socket.id) {

                io.to(sessionId).emit("session-ended");

                sessions.delete(sessionId);

                console.log("Host disconnected:", sessionId);
            }

        }

    });

});

// ------------------------------------
// START SERVER
// ------------------------------------

httpServer.listen(PORT, "0.0.0.0", () => {

    console.log(
        `QuickShare server running on port ${PORT}`
    );

});