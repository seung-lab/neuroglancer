import { spawn } from "child_process";

const test1 = spawn(
    "uv",
    ["--project", "build_tools/vitest/python_tools", "run", "-v", "moto_server", "-p", "0"],
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
test1.on("close", (code, signal) => {
  console.log(`test1 process closed with code ${code}, signal ${signal}`);
});
test1.on("message", (message) => {
  console.log("test1 process message", message);
});
test1.on("spawn", () => {
  console.log("test1 process spawned");
});

setTimeout(() => {
  test1.kill();
}, 30000);

