import http from "node:http";
import { FakePowerShell } from "./fake-powershell.js";

/*
 * Serves the toy PowerShell over plain HTTP for scripts/oracle/winrm_server.py
 * (ORACLE_UPSTREAM), which adds the NTLM login and message encryption. For
 * manual end-to-end runs against a local Termix only; never shipped.
 */
const fake = new FakePowerShell();
const channel = fake.channel();
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    channel
      .send(Buffer.concat(chunks).toString("utf8"), 60_000)
      .then((answer) => res.end(answer))
      .catch((error: unknown) => {
        res.statusCode = 500;
        res.end(String(error));
      });
  });
});
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  console.log((server.address() as { port: number }).port);
});
