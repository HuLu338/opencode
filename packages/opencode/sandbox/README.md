# Cost-aware validation sandbox

This image runs only deterministic validation. OpenCode, model credentials, implementation, and review stay on the host.

## Windows setup

Install Docker Desktop with the WSL 2 backend. To keep the application and Linux container data on drive D, run the following from an administrator PowerShell window and approve the Windows UAC prompt yourself:

```powershell
$installer = "$env:USERPROFILE\Downloads\Docker Desktop Installer.exe"
$arguments = @(
  "install",
  "--quiet",
  "--accept-license",
  "--no-windows-containers",
  "--backend=wsl-2",
  "--installation-dir=D:\DevTools\DockerDesktop",
  "--wsl-default-data-root=D:\DockerData\wsl"
)
Start-Process -FilePath $installer -ArgumentList $arguments -Verb RunAs -Wait
```

After Docker Desktop reports that the Linux engine is running, build the pinned local image from the repository root:

```text
docker build -f packages/opencode/sandbox/Dockerfile -t opencode-cost-aware-sandbox:local .
```

Set `cost_aware.sandbox.enabled` to `true` in `.opencode/opencode.jsonc` only after the image build succeeds. Set it back to `false` to use host validation while diagnosing Docker.

## Security boundary

- The only host mount is the current repository, mounted read-only at `/workspace`.
- Validation runs against a filtered copy on an anonymous volume removed with the container.
- The root filesystem is read-only; Linux capabilities are dropped and `no-new-privileges` is enabled.
- Runtime networking is disabled by default.
- CPU, memory, and process counts are bounded.
- Docker socket, SSH data, browser profiles, environment files, local task state, and personal directories are never mounted or copied.

Docker exit code 125 or a missing Docker executable is recorded as unavailable validation. It does not consume an implementation attempt or trigger model escalation.
