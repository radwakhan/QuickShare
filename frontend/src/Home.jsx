import { useState, useRef, useEffect } from "react";
import { io } from "socket.io-client";
import { QRCodeSVG } from "qrcode.react";

function Home() {
    const [sessionId, setSessionId] = useState("");
    const [status, setStatus] = useState("Not connected");
    const [selectedFiles, setSelectedFiles] = useState([]);
    const [progress, setProgress] = useState(0);
    const [transferStatus, setTransferStatus] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [isConnected, setIsConnected] = useState(false);

    const socketRef = useRef(null);
    const sessionIdRef = useRef("");

    const peerConnections = useRef({});
    const dataChannels = useRef({});
    const pendingCandidates = useRef({});

    const MAX_FILE_SIZE = 100 * 1024 * 1024;
    const CHUNK_SIZE = 16 * 1024;
    const BUFFER_LIMIT = 1024 * 1024;

    const configuration = {
        iceServers: [
            {
                urls: "stun:stun.l.google.com:19302"
            }
        ]
    };

    // CREATE WEBRTC CONNECTION
    async function createPeerConnection(peerId) {
        const peer = new RTCPeerConnection(configuration);

        peerConnections.current[peerId] = peer;

        const dataChannel = peer.createDataChannel("file-transfer");

        dataChannel.binaryType = "arraybuffer";
        dataChannel.bufferedAmountLowThreshold = BUFFER_LIMIT;

        dataChannels.current[peerId] = dataChannel;

        dataChannel.onopen = () => {
            console.log("Data channel opened!");
            setIsConnected(true);
            setStatus("Connected! Ready to transfer files.");
        };

        dataChannel.onclose = () => {
            console.log("Data channel closed.");
            delete dataChannels.current[peerId];
            setIsConnected(false);
            setStatus("Data channel closed.");
        };

        dataChannel.onerror = (error) => {
            console.error("Data channel error:", error);
        };

        // ICE CANDIDATES
        peer.onicecandidate = (event) => {
            if (event.candidate) {
                socketRef.current.emit("signal", {
                    sessionId: sessionIdRef.current,
                    signal: {
                        type: "ice-candidate",
                        candidate: event.candidate
                    }
                });
            }
        };

        // CONNECTION STATE
        peer.onconnectionstatechange = () => {
            console.log("Connection state:", peer.connectionState);

            if (peer.connectionState === "connected") {
                setStatus("Connected! Ready to transfer files.");
            }

            if (peer.connectionState === "failed") {
                setStatus("WebRTC connection failed.");
                setIsConnected(false);
            }

            if (peer.connectionState === "disconnected") {
                setStatus("Device disconnected.");
                setIsConnected(false);
            }
        };

        // CREATE OFFER
        const offer = await peer.createOffer();

        await peer.setLocalDescription(offer);

        socketRef.current.emit("signal", {
            sessionId: sessionIdRef.current,
            signal: {
                type: "offer",
                sdp: peer.localDescription
            }
        });

        console.log("WebRTC offer sent to:", peerId);
    }

    // HANDLE INCOMING SIGNALS
    async function handleSignal(data) {
        const peer = peerConnections.current[data.senderId];

        if (!peer) {
            console.log("No matching peer connection:", data.senderId);
            return;
        }

        const signal = data.signal;

        try {
            // RECEIVE ANSWER
            if (signal.type === "answer") {
                await peer.setRemoteDescription(
                    new RTCSessionDescription(signal.sdp)
                );

                console.log("WebRTC answer received!");

                const candidates =
                    pendingCandidates.current[data.senderId] || [];

                for (const candidate of candidates) {
                    await peer.addIceCandidate(
                        new RTCIceCandidate(candidate)
                    );
                }

                pendingCandidates.current[data.senderId] = [];
            }

            // RECEIVE ICE CANDIDATES
            if (signal.type === "ice-candidate") {
                const candidate = signal.candidate;

                if (peer.remoteDescription) {
                    await peer.addIceCandidate(
                        new RTCIceCandidate(candidate)
                    );
                } else {
                    if (!pendingCandidates.current[data.senderId]) {
                        pendingCandidates.current[data.senderId] = [];
                    }

                    pendingCandidates.current[data.senderId].push(candidate);
                }
            }
        } catch (error) {
            console.error("Signaling error:", error);
        }
    }

    // CREATE SHARING SESSION
    function createSession() {
        if (socketRef.current) {
            socketRef.current.disconnect();
        }

        setStatus("Connecting to server...");

        const socket = io("http://localhost:3000");

        socketRef.current = socket;

        socket.on("connect", () => {
            console.log("Connected to backend:", socket.id);

            socket.emit("create-session", (response) => {
                if (!response || !response.success) {
                    setStatus("Could not create session.");
                    return;
                }

                sessionIdRef.current = response.sessionId;

                setSessionId(response.sessionId);

                setStatus("Waiting for phone to join...");

                console.log("Session created:", response.sessionId);
            });
        });

        socket.on("connect_error", (error) => {
            console.error("Backend connection error:", error);
            setStatus("Could not connect to backend.");
        });

        // PHONE JOINS
        socket.on("peer-joined", async ({ peerId }) => {
            console.log("Phone joined:", peerId);

            setStatus("Phone joined! Establishing WebRTC connection...");

            try {
                await createPeerConnection(peerId);
            } catch (error) {
                console.error("Offer creation failed:", error);
                setStatus("Could not create WebRTC connection.");
            }
        });

        socket.on("signal", handleSignal);

        socket.on("session-expired", () => {
            setStatus("Sharing session expired.");
            setIsConnected(false);
        });

        socket.on("session-ended", () => {
            setStatus("Laptop disconnected.");
            setIsConnected(false);
        });
    }

    // SELECT MULTIPLE FILES
    function handleFileSelect(event) {
        const files = Array.from(event.target.files || []);

        const oversizedFiles = files.filter(
            file => file.size > MAX_FILE_SIZE
        );

        if (oversizedFiles.length > 0) {
            alert(
                "Each file must be 100 MB or smaller.\n\n" +
                oversizedFiles.map(file => file.name).join("\n")
            );

            event.target.value = "";
            return;
        }

        setSelectedFiles(files);
        setProgress(0);
        setTransferStatus("");

        console.log("Selected files:", files);
    }

    // WAIT FOR DATA CHANNEL BUFFER
    async function waitForBuffer(dataChannel) {
        while (dataChannel.bufferedAmount > BUFFER_LIMIT) {
            if (dataChannel.readyState !== "open") {
                throw new Error("Connection closed during transfer.");
            }

            await new Promise(resolve => setTimeout(resolve, 10));
        }

        if (dataChannel.readyState !== "open") {
            throw new Error("Data channel is not open.");
        }
    }

    // SEND ONE FILE
    async function sendFile(dataChannel, file, fileIndex, totalBytesSent, totalSize) {
        const fileId = crypto.randomUUID();

        // SEND FILE INFORMATION
        dataChannel.send(JSON.stringify({
            type: "file-start",
            id: fileId,
            name: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream"
        }));

        let offset = 0;

        // SEND FILE IN CHUNKS
        while (offset < file.size) {
            await waitForBuffer(dataChannel);

            const chunk = await file
                .slice(offset, offset + CHUNK_SIZE)
                .arrayBuffer();

            dataChannel.send(chunk);

            offset += chunk.byteLength;

            const overallProgress = totalBytesSent + offset;

            const percentage = totalSize === 0
                ? 100
                : Math.round((overallProgress / totalSize) * 100);

            setProgress(percentage);

            setTransferStatus(
                `Sending file ${fileIndex + 1} of ${selectedFiles.length}: ${file.name}`
            );
        }

        await waitForBuffer(dataChannel);

        // SEND FILE COMPLETION MESSAGE
        dataChannel.send(JSON.stringify({
            type: "file-end",
            id: fileId
        }));

        return file.size;
    }

    // SEND MULTIPLE FILES
    async function sendFiles() {
        if (selectedFiles.length === 0) {
            setTransferStatus("Please select files first.");
            return;
        }

        const peerId = Object.keys(dataChannels.current).find(
            id => dataChannels.current[id].readyState === "open"
        );

        if (!peerId) {
            setTransferStatus("No connected device found.");
            return;
        }

        const dataChannel = dataChannels.current[peerId];

        const totalSize = selectedFiles.reduce(
            (total, file) => total + file.size,
            0
        );

        let totalBytesSent = 0;

        try {
            setIsSending(true);
            setProgress(0);
            setTransferStatus("Starting file transfer...");

            for (let i = 0; i < selectedFiles.length; i++) {
                const file = selectedFiles[i];

                totalBytesSent += await sendFile(
                    dataChannel,
                    file,
                    i,
                    totalBytesSent,
                    totalSize
                );
            }

            setProgress(100);

            setTransferStatus(
                `All ${selectedFiles.length} files sent successfully!`
            );

            console.log("All file transfers completed!");

        } catch (error) {
            console.error("File transfer error:", error);

            setTransferStatus(
                "File transfer failed: " + error.message
            );

        } finally {
            setIsSending(false);
        }
    }

    // CLEANUP
    useEffect(() => {
        return () => {
            Object.values(peerConnections.current).forEach(peer => {
                peer.close();
            });

            if (socketRef.current) {
                socketRef.current.disconnect();
            }
        };
    }, []);

    // QR CODE URL
    const shareUrl = sessionId
        ? `${window.location.origin}/join/${sessionId}`
        : "";

    return (
        <div style={{
            textAlign: "center",
            padding: "40px",
            maxWidth: "700px",
            margin: "auto"
        }}>

            <h1>QuickShare</h1>

            <p>Share files between your devices.</p>

            {/* CREATE SESSION */}
            <button
                onClick={createSession}
                disabled={!!sessionId}
            >
                Create Sharing Session
            </button>

            <h3>Status: {status}</h3>

            {/* QR CODE */}
            {sessionId && (
                <div>
                    <h3>Your Session ID</h3>

                    <p>{sessionId}</p>

                    <h3>Scan to Connect</h3>

                    <QRCodeSVG
                        value={shareUrl}
                        size={220}
                        level="H"
                    />

                    <p>Scan this QR code to join.</p>

                    <p>{shareUrl}</p>
                </div>
            )}

            <hr style={{ margin: "30px 0" }} />

            {/* FILE TRANSFER */}
            <h2>Send Files</h2>

            <p>Maximum size per file: 100 MB</p>

            <input
                type="file"
                multiple
                onChange={handleFileSelect}
                disabled={isSending}
                style={{ margin: "15px" }}
            />

            {/* SELECTED FILES */}
            {selectedFiles.length > 0 && (
                <div>
                    <h3>Selected Files ({selectedFiles.length})</h3>

                    {selectedFiles.map((file, index) => (
                        <div
                            key={`${file.name}-${index}`}
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                padding: "10px",
                                margin: "8px 0",
                                background: "#f1f5f9",
                                borderRadius: "5px"
                            }}
                        >
                            <span>{file.name}</span>

                            <span>
                                {(file.size / 1024 / 1024).toFixed(2)} MB
                            </span>
                        </div>
                    ))}

                    <button
                        onClick={sendFiles}
                        disabled={!isConnected || isSending}
                    >
                        {isSending ? "Sending..." : "Send All Files"}
                    </button>
                </div>
            )}

            {/* TRANSFER PROGRESS */}
            {transferStatus && (
                <div>
                    <h3>{transferStatus}</h3>

                    <progress
                        value={progress}
                        max="100"
                        style={{ width: "250px" }}
                    />

                    <p>{progress}%</p>
                </div>
            )}

        </div>
    );
}

export default Home;