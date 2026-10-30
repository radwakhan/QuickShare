import { useState, useRef, useEffect } from "react";
import { io } from "socket.io-client";
import { useParams } from "react-router-dom";

function Phone() {
    const { sessionId } = useParams();

    const [status, setStatus] = useState("Connecting...");
    const [receivedFiles, setReceivedFiles] = useState([]);
    const [currentFileName, setCurrentFileName] = useState("");
    const [progress, setProgress] = useState(0);

    const socketRef = useRef(null);
    const peerRef = useRef(null);

    const pendingCandidates = useRef([]);
    const fileChunks = useRef([]);
    const currentFile = useRef(null);
    const receivedBytes = useRef(0);
    const downloadUrls = useRef([]);

    const MAX_FILE_SIZE = 100 * 1024 * 1024;

    useEffect(() => {
        if (!sessionId) {
            setStatus("Invalid session.");
            return;
        }

        const socket = io("http://localhost:3000");

        socketRef.current = socket;

        socket.on("connect", () => {
            setStatus("Joining session...");

            socket.emit("join-session", sessionId, (response) => {
                if (!response || !response.success) {
                    setStatus(
                        response?.message || "Could not join session."
                    );
                    return;
                }

                setStatus("Joined successfully. Waiting for laptop...");
            });
        });

        socket.on("connect_error", (error) => {
            console.error("Socket error:", error);
            setStatus("Could not connect to backend.");
        });

        // HANDLE SIGNALS
        socket.on("signal", async (data) => {
            const signal = data.signal;

            try {
                // RECEIVE OFFER
                if (signal.type === "offer") {
                    await handleOffer(signal.sdp, socket);
                }

                // RECEIVE ICE CANDIDATES
                if (signal.type === "ice-candidate") {
                    const candidate = signal.candidate;

                    if (peerRef.current?.remoteDescription) {
                        await peerRef.current.addIceCandidate(
                            new RTCIceCandidate(candidate)
                        );
                    } else {
                        pendingCandidates.current.push(candidate);
                    }
                }

            } catch (error) {
                console.error("Signaling error:", error);
                setStatus("Connection error.");
            }
        });

        socket.on("session-expired", () => {
            setStatus("Session expired.");
        });

        socket.on("session-ended", () => {
            setStatus("Sender disconnected.");
        });

        return () => {
            socket.disconnect();

            peerRef.current?.close();

            downloadUrls.current.forEach(url => {
                URL.revokeObjectURL(url);
            });
        };

    }, [sessionId]);

    // HANDLE WEBRTC OFFER
    async function handleOffer(offer, socket) {
        const peer = new RTCPeerConnection({
            iceServers: [
                {
                    urls: "stun:stun.l.google.com:19302"
                }
            ]
        });

        peerRef.current = peer;

        // RECEIVE DATA CHANNEL
        peer.ondatachannel = (event) => {
            const dataChannel = event.channel;

            dataChannel.binaryType = "arraybuffer";

            dataChannel.onopen = () => {
                setStatus("Connected to laptop! Ready to receive files.");
            };

            dataChannel.onclose = () => {
                setStatus("Data channel closed.");
            };

            dataChannel.onmessage = handleIncomingData;
        };

        // ICE CANDIDATES
        peer.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("signal", {
                    sessionId,
                    signal: {
                        type: "ice-candidate",
                        candidate: event.candidate
                    }
                });
            }
        };

        await peer.setRemoteDescription(
            new RTCSessionDescription(offer)
        );

        // ADD PENDING CANDIDATES
        for (const candidate of pendingCandidates.current) {
            await peer.addIceCandidate(
                new RTCIceCandidate(candidate)
            );
        }

        pendingCandidates.current = [];

        // CREATE ANSWER
        const answer = await peer.createAnswer();

        await peer.setLocalDescription(answer);

        socket.emit("signal", {
            sessionId,
            signal: {
                type: "answer",
                sdp: peer.localDescription
            }
        });

        setStatus("Connecting to laptop...");
    }

    // HANDLE INCOMING DATA
    function handleIncomingData(event) {
        const data = event.data;

        if (typeof data === "string") {
            let message;

            try {
                message = JSON.parse(data);
            } catch (error) {
                console.error("Invalid message:", error);
                return;
            }

            if (message.type === "file-start") {
                startReceivingFile(message);
            }

            if (message.type === "file-end") {
                finishReceivingFile(message);
            }

            return;
        }

        if (data instanceof ArrayBuffer) {
            receiveChunk(data);
        }
    }

    // START RECEIVING FILE
    function startReceivingFile(message) {
        if (message.size > MAX_FILE_SIZE) {
            setStatus("File exceeds the 100 MB limit.");

            currentFile.current = null;
            fileChunks.current = [];
            receivedBytes.current = 0;

            return;
        }

        currentFile.current = {
            id: message.id,
            name: message.name,
            size: message.size,
            mimeType: message.mimeType || "application/octet-stream"
        };

        fileChunks.current = [];
        receivedBytes.current = 0;

        setCurrentFileName(message.name);
        setProgress(0);

        setStatus(`Receiving ${message.name}...`);
    }

    // RECEIVE FILE CHUNKS
    function receiveChunk(chunk) {
        if (!currentFile.current) {
            return;
        }

        fileChunks.current.push(chunk);

        receivedBytes.current += chunk.byteLength;

        const fileSize = currentFile.current.size;

        const percentage = fileSize === 0
            ? 100
            : Math.min(
                100,
                Math.round((receivedBytes.current / fileSize) * 100)
            );

        setProgress(percentage);
    }

    // FINISH RECEIVING FILE
    function finishReceivingFile(message) {
        const file = currentFile.current;

        if (!file || message.id !== file.id) {
            setStatus("File transfer error: file information mismatch.");
            return;
        }

        if (receivedBytes.current !== file.size) {
            setStatus(`Incomplete file: ${file.name}`);

            currentFile.current = null;
            fileChunks.current = [];
            receivedBytes.current = 0;

            return;
        }

        // CREATE FILE
        const blob = new Blob(fileChunks.current, {
            type: file.mimeType
        });

        const downloadUrl = URL.createObjectURL(blob);

        downloadUrls.current.push(downloadUrl);

        const completedFile = {
            id: file.id,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
            url: downloadUrl
        };

        // ADD FILE WITHOUT REMOVING PREVIOUS FILES
        setReceivedFiles(previousFiles => [
            ...previousFiles,
            completedFile
        ]);

        setProgress(100);

        setStatus(`${file.name} received successfully!`);

        currentFile.current = null;
        fileChunks.current = [];
        receivedBytes.current = 0;
    }

    // FORMAT FILE SIZE
    function formatFileSize(size) {
        if (size < 1024) {
            return size + " Bytes";
        }

        if (size < 1024 * 1024) {
            return (size / 1024).toFixed(2) + " KB";
        }

        return (size / (1024 * 1024)).toFixed(2) + " MB";
    }

    return (
        <div style={{
            maxWidth: "700px",
            margin: "40px auto",
            padding: "25px",
            textAlign: "center",
            fontFamily: "Arial"
        }}>

            <h1>QuickShare</h1>

            <p>Receive files from your laptop.</p>

            <h3>Status: {status}</h3>

            {/* CURRENT FILE PROGRESS */}
            {currentFileName && (
                <div>
                    <h3>Receiving: {currentFileName}</h3>

                    <progress
                        value={progress}
                        max="100"
                        style={{ width: "100%" }}
                    />

                    <p>{progress}%</p>
                </div>
            )}

            <hr style={{ margin: "30px 0" }} />

            {/* RECEIVED FILES */}
            <h2>Received Files ({receivedFiles.length})</h2>

            {receivedFiles.length === 0 && (
                <p>No files received yet.</p>
            )}

            {receivedFiles.map(file => (
                <div
                    key={file.id}
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "15px",
                        padding: "15px",
                        margin: "10px 0",
                        background: "#f1f5f9",
                        borderRadius: "6px"
                    }}
                >

                    <div style={{
                        textAlign: "left",
                        overflowWrap: "anywhere"
                    }}>
                        <strong>{file.name}</strong>

                        <p>{formatFileSize(file.size)}</p>
                    </div>

                    <a
                        href={file.url}
                        download={file.name}
                        style={{
                            padding: "10px 15px",
                            background: "#16a34a",
                            color: "white",
                            textDecoration: "none",
                            borderRadius: "5px",
                            whiteSpace: "nowrap"
                        }}
                    >
                        Download
                    </a>

                </div>
            ))}

        </div>
    );
}

export default Phone;