import WebSocket from "ws";

console.log("Creating socket...");

const ws = new WebSocket("wss://smartapisocket.angelone.in/smart-stream");

ws.on("open", () => {
    console.log("OPEN");
});

ws.on("error", (err) => {
    console.log("ERROR");
    console.dir(err, { depth: null });
});

ws.on("close", (code, reason) => {
    console.log("CLOSE", code, reason.toString());
});

setInterval(() => {
    console.log("Alive", new Date().toISOString());
}, 5000);