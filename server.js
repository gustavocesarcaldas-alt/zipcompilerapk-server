
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "ZipCompilerAPK" });
});

app.post("/build", upload.single("zip_file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Envie um arquivo ZIP no campo zip_file." });
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "zipcompiler-"));
  const zipPath = req.file.path;
  const output = path.join(temp, "output.apk");

  try {
    const name = String(req.body.app_name || "Meu Aplicativo");
    const pkg = String(req.body.package_name || "com.exemplo.meuapp");
    const type = String(req.body.project_type || "android");

    if (!/^[a-zA-Z0-9._ -]{1,60}$/.test(name)) {
      throw new Error("Nome de aplicativo inválido.");
    }

    if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg)) {
      throw new Error("Package name inválido.");
    }

    if (!["android", "html"].includes(type)) {
      throw new Error("Tipo de projeto inválido.");
    }

    const src = path.join(temp, "src");
    fs.mkdirSync(src);

    await execFileAsync("unzip", ["-q", zipPath, "-d", src]);

    const gradlew = await findFile(src, "gradlew");
    let projectDir;

    if (gradlew) {
      projectDir = path.dirname(gradlew);
    } else {
      const index = await findFile(src, "index.html");

      if (!index || type !== "html") {
        throw new Error("ZIP precisa conter um projeto Gradle Android ou index.html para projeto HTML.");
      }

      projectDir = await makeHtmlProject(temp, index, name, pkg);
    }

    await execFileAsync("chmod", ["+x", path.join(projectDir, "gradlew")]);

    await execFileAsync(
      path.join(projectDir, "gradlew"),
      ["assembleDebug"],
      {
        cwd: projectDir,
        timeout: 15 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    const apk = await findApk(projectDir);

    if (!apk) throw new Error("A compilação terminou sem gerar APK.");

    res.download(apk, "MeuAplicativo.apk");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Não foi possível compilar o APK.",
        details: String(err.message || err).slice(0, 1200)
      });
    }
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(zipPath, { force: true }); } catch {}
  }
});

async function findFile(dir, filename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name === filename) return full;

    if (entry.isDirectory() &&
        !["node_modules", ".git", "build"].includes(entry.name)) {
      const found = await findFile(full, filename);
      if (found) return found;
    }
  }

  return null;
}

async function findApk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;

    if (entry.isFile() && entry.name.endsWith(".apk") &&
        full.includes("outputs")) return full;

    if (entry.isDirectory()) {
      const found = await findApk(full);
      if (found) return found;
    }
  }

  return null;
}

async function makeHtmlProject(temp, index, name, pkg) {
  const wrapper = path.join(temp, "html-project");
  const webDir = path.join(wrapper, "www");
  fs.mkdirSync(webDir, { recursive: true });

  fs.cpSync(path.dirname(index), webDir, { recursive: true });

  const safeName = name.replace(/"/g, '\\"');
  const safePkg = pkg.replace(/"/g, '\\"');

  fs.writeFileSync(path.join(wrapper, "package.json"), JSON.stringify({
    name: "generated-android-app",
    version: "1.0.0",
    private: true
  }, null, 2));

  await execFileAsync("npm", [
    "install",
    "--prefix", wrapper,
    "@capacitor/core@6",
    "@capacitor/cli@6",
    "@capacitor/android@6"
  ], { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });

  fs.writeFileSync(path.join(wrapper, "capacitor.config.json"), JSON.stringify({
    appId: safePkg,
    appName: safeName,
    webDir: "www"
  }, null, 2));

  await execFileAsync("npx", ["cap", "add", "android"], {
    cwd: wrapper,
    timeout: 3 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024
  });

  return path.join(wrapper, "android");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ZipCompilerAPK rodando na porta ${PORT}`);
});
