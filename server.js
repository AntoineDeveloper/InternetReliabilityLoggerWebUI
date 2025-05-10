const express = require('express');
const path = require('path');
const ping = require('ping');

const app = express();
const port = 3000;

// --- Configuration ---
const PING_TARGET = '8.8.8.8'; // Google's Public DNS (reliable) or your router IP
const PING_INTERVAL_MS = 5000; // Check every 5 seconds
const MAX_HISTORY_LENGTH = 100; // Keep last 100 stats entries
const LATENCY_THRESHOLD_WARN_MS = 150; // Warn if latency exceeds this
const LATENCY_THRESHOLD_ERROR_MS = 500; // Error if latency exceeds this
const PACKET_LOSS_THRESHOLD_WARN = 5;  // Warn if packet loss % exceeds this
const PACKET_LOSS_THRESHOLD_ERROR = 20; // Error if packet loss % exceeds this
const JITTER_THRESHOLD_WARN_MS = 50;
const JITTER_THRESHOLD_ERROR_MS = 150;

// --- Data Storage (in-memory) ---
let statsHistory = [];
let hiccups = [];
let currentStats = {
    timestamp: null,
    avgLatency: null,
    minLatency: null,
    maxLatency: null,
    packetLoss: null,
    jitter: null,
    isAlive: false,
    overallStatus: "Initializing...",
    overallStatusClass: "status-warning",
    latencyClass: "",
    lossClass: "",
    jitterClass: ""
};
const serverStartTime = Date.now();

// --- Express Setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes ---
app.get('/', (req, res) => {
    res.render('index', {
        statsHistory: statsHistory,
        hiccups: hiccups,
        currentStats: currentStats,
        serverStartTime: serverStartTime,
        pingTarget: PING_TARGET
    });
});

// --- Network Monitoring Logic ---
async function checkNetworkStatus() {
    const timestamp = Date.now();
    let isHiccup = false;
    let hiccupReason = [];

    try {
        // ping.promise.probe sends 10 packets by default on Linux/Mac, 4 on Windows
        // We can configure packet count:
        const res = await ping.promise.probe(PING_TARGET, {
            timeout: 4, // Wait 4 seconds for all pings
            min_reply: 3, // Consider it a failure if less than 3 replies (for 4 packets sent)
            // extra: ["-c", "4"] // Explicitly send 4 packets on all platforms
        });

        const avgLatency = res.avg ? parseFloat(res.avg) : null;
        const minLatency = res.min ? parseFloat(res.min) : null;
        const maxLatency = res.max ? parseFloat(res.max) : null;
        const packetLoss = res.packetLoss ? parseFloat(res.packetLoss) : 0; // Default to 0 if undefined
        const isAlive = res.alive;
        const jitter = (maxLatency !== null && minLatency !== null) ? (maxLatency - minLatency) : null;


        currentStats = { // Update current stats
            timestamp: timestamp,
            avgLatency: avgLatency,
            minLatency: minLatency,
            maxLatency: maxLatency,
            packetLoss: packetLoss,
            jitter: jitter,
            isAlive: isAlive,
            overallStatus: "Stable",
            overallStatusClass: "status-ok",
            latencyClass: "",
            lossClass: "",
            jitterClass: ""
        };

        if (!isAlive) {
            isHiccup = true;
            hiccupReason.push("Host Unreachable");
            currentStats.overallStatus = "Error: Host Unreachable";
            currentStats.overallStatusClass = "status-error";
        } else {
            // Latency checks
            if (avgLatency > LATENCY_THRESHOLD_ERROR_MS) {
                isHiccup = true;
                hiccupReason.push(`Critical Latency (${avgLatency}ms)`);
                currentStats.latencyClass = "status-error";
                currentStats.overallStatus = "Error";
                currentStats.overallStatusClass = "status-error";
            } else if (avgLatency > LATENCY_THRESHOLD_WARN_MS) {
                currentStats.latencyClass = "status-warning";
                if (currentStats.overallStatus === "Stable") { // Don't override an error
                     currentStats.overallStatus = "Warning: High Latency";
                     currentStats.overallStatusClass = "status-warning";
                }
            } else {
                 currentStats.latencyClass = "status-ok";
            }

            // Packet loss checks
            if (packetLoss > PACKET_LOSS_THRESHOLD_ERROR) {
                isHiccup = true;
                hiccupReason.push(`Critical Packet Loss (${packetLoss}%)`);
                currentStats.lossClass = "status-error";
                currentStats.overallStatus = "Error"; // Overrides previous status if it was just warning
                currentStats.overallStatusClass = "status-error";
            } else if (packetLoss > PACKET_LOSS_THRESHOLD_WARN) {
                currentStats.lossClass = "status-warning";
                if (currentStats.overallStatus === "Stable") {
                     currentStats.overallStatus = "Warning: Packet Loss";
                     currentStats.overallStatusClass = "status-warning";
                }
            } else {
                currentStats.lossClass = "status-ok";
            }

             // Jitter checks
            if (jitter !== null) {
                if (jitter > JITTER_THRESHOLD_ERROR_MS) {
                    isHiccup = true;
                    hiccupReason.push(`High Jitter (${jitter}ms)`);
                    currentStats.jitterClass = "status-error";
                    if (currentStats.overallStatus !== "Error") {
                         currentStats.overallStatus = "Error: High Jitter";
                         currentStats.overallStatusClass = "status-error";
                    }
                } else if (jitter > JITTER_THRESHOLD_WARN_MS) {
                    currentStats.jitterClass = "status-warning";
                     if (currentStats.overallStatus === "Stable") {
                         currentStats.overallStatus = "Warning: High Jitter";
                         currentStats.overallStatusClass = "status-warning";
                    }
                } else {
                    currentStats.jitterClass = "status-ok";
                }
            }
        }


        // Add to history
        statsHistory.push({
            timestamp: timestamp,
            avgLatency: avgLatency,
            minLatency: minLatency,
            maxLatency: maxLatency,
            packetLoss: packetLoss,
            jitter: jitter,
            isAlive: isAlive
        });
        if (statsHistory.length > MAX_HISTORY_LENGTH) {
            statsHistory.shift(); // Keep history to a manageable size
        }

        if (isHiccup) {
            hiccups.push({
                timestamp: timestamp,
                reason: hiccupReason.join(', '),
                latency: avgLatency,
                packetLoss: packetLoss
            });
             console.warn(`[${new Date(timestamp).toLocaleString()}] Hiccup Detected: ${hiccupReason.join(', ')} (Latency: ${avgLatency}ms, Loss: ${packetLoss}%)`);
        }

    } catch (error) {
        console.error(`[${new Date(timestamp).toLocaleString()}] Error pinging ${PING_TARGET}:`, error.message);
        currentStats = {
            timestamp: timestamp,
            avgLatency: null,
            minLatency: null,
            maxLatency: null,
            packetLoss: 100, // Assume 100% loss on error
            jitter: null,
            isAlive: false,
            overallStatus: "Error: Ping Failed",
            overallStatusClass: "status-error",
            latencyClass: "status-error",
            lossClass: "status-error",
            jitterClass: "status-error"
        };
        statsHistory.push({ ...currentStats }); // Add error state to history
         if (statsHistory.length > MAX_HISTORY_LENGTH) statsHistory.shift();

        hiccups.push({
            timestamp: timestamp,
            reason: `Ping command failed: ${error.message}`,
            latency: null,
            packetLoss: 100
        });
    }
    // console.log(`[${new Date(currentStats.timestamp).toLocaleString()}] Status: ${currentStats.overallStatus}, Latency: ${currentStats.avgLatency}ms, Loss: ${currentStats.packetLoss}%, Jitter: ${currentStats.jitter}ms`);
}

// Start monitoring
checkNetworkStatus(); // Initial check
setInterval(checkNetworkStatus, PING_INTERVAL_MS);

app.listen(port, () => {
    console.log(`Network monitor running at http://localhost:${port}`);
    console.log(`Monitoring target: ${PING_TARGET} every ${PING_INTERVAL_MS / 1000} seconds.`);
});