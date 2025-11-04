
import { spawn } from "child_process";
import path from "path";

export async function runRemixPython(
  payload: any,
  absPath = process.env.REMIX_PY_PATH || path.join(process.cwd(), "server/scripts/remix_timeline.py")
) {
  return new Promise<any>((resolve, reject) => {
    const p = spawn("python3", [absPath], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";

    p.stdout.on("data", d => (out += d.toString()));
    p.stderr.on("data", d => (err += d.toString()));
    
    p.on("close", code => {
      if (code !== 0) {
        return reject(new Error(err || `remix_timeline.py exit ${code}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error("Invalid JSON from remix_timeline.py: " + e + "\n" + out));
      }
    });

    p.on("error", (error) => {
      reject(new Error(`Failed to spawn Python process: ${error.message}`));
    });

    try {
      p.stdin.write(JSON.stringify(payload));
      p.stdin.end();
    } catch (writeError: any) {
      reject(new Error(`Failed to write to Python process: ${writeError.message}`));
    }
  });
}
