import { createInterface } from "node:readline";

function frage(text: string, verdeckt = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (verdeckt) {
      process.stderr.write(text);
      const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
      stdin.setRawMode?.(true);
      let wert = "";
      const onData = (chunk: Buffer) => {
        const c = chunk.toString();
        if (c === "\r" || c === "\n") {
          stdin.setRawMode?.(false);
          stdin.off("data", onData);
          process.stderr.write("\n");
          rl.close();
          resolve(wert);
        } else if (c === "\u0003") {
          stdin.setRawMode?.(false);
          process.exit(130);
        } else if (c === "\u007f") {
          wert = wert.slice(0, -1);
        } else {
          wert += c;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(text, (antwort) => {
        rl.close();
        resolve(antwort);
      });
    }
  });
}

const url = ((await frage("Desk-Server-URL [http://localhost:4810]: ")) || "http://localhost:4810").replace(/\/+$/, "");
const username = await frage("Benutzername: ");
const password = await frage("Passwort: ", true);

try {
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401) {
    console.error("Benutzername oder Passwort falsch");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Login fehlgeschlagen (HTTP ${res.status})`);
    process.exit(1);
  }
  const { token } = (await res.json()) as { token: string };
  console.log(token);
} catch {
  console.error("Server nicht erreichbar — URL prüfen");
  process.exit(1);
}
