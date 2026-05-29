import "./db"; // run migrations on startup
import { createServer } from "./app";

const PORT = parseInt(process.env.PORT || "3000");
const server = createServer(PORT);

console.log(`Fileshare server running on http://localhost:${PORT}`);

export default server;
