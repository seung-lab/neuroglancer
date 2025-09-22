import { spawn } from "node:child_process";
// import { describe, test } from "vitest";

export const startMotoServer = async () => {
    const test1 = spawn(
      "uv",
      [
        "--project",
        "build_tools/vitest/python_tools",
        "run",
        "moto_server",
        "-p",
        "0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    test1.stderr.on("data", (data) => {
      console.log("stderr: ", data.toString());
    });

    test1.stdout.on("data", (data) => {
      console.log("stdout: ", data.toString());
    });

    test1.on("error", (err) => {
      console.error("test1 process error", err);
    });
    test1.on("exit", (code, signal) => {
      console.log(`test1 process exited with code ${code}, signal ${signal}`);
    });
    test1.on("message", (message) => {
      console.log("test1 process message", message);
    });
    test1.on("spawn", () => {
      console.log("test1 process spawned");
      setTimeout(() => {
        console.log("kill test1");
        test1.kill();
      }, 30000);
    });
    const waitForClose = new Promise<void>((resolve) => {
      test1.on("close", (code, signal) => {
        console.log(`test1 process closed with code ${code}, signal ${signal}`);
        resolve();
      });
    });
    await waitForClose;
};
  
startMotoServer().catch((err) => {
  console.error("Error starting moto server:", err);
  process.exit(1);
});
