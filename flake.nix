{
  description = "aicoder-opencode control-plane flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs = {nixpkgs, ...}: let
    supportedSystems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];

    forEachSupportedSystem = function:
      nixpkgs.lib.genAttrs supportedSystems (
        system:
          function (import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          })
      );
  in {
    formatter = forEachSupportedSystem (pkgs: pkgs.alejandra);

    devShells = forEachSupportedSystem (
      pkgs: let
        developmentPackages = [
          pkgs.bun
          pkgs.nodejs_24
          pkgs.typescript
          pkgs.typescript-language-server
          pkgs.git
          pkgs.ripgrep
          pkgs.jq
          pkgs.yq
          pkgs.just
          pkgs.bubblewrap
          pkgs.jujutsu
          pkgs.nixfmt
          pkgs.alejandra
          pkgs.deadnix
          pkgs.statix
        ];
      in {
        default = pkgs.mkShell {
          packages = developmentPackages;

          shellHook = ''
            export PATH="$PWD/bin:$PWD/node_modules/.bin:$PATH"
            export AICODER_OPENCODE_FLAKE=1

            echo "aicoder-opencode nix dev shell"
            echo "toolchain: bun $(bun --version) | node $(node --version) | npm $(npm --version)"
            echo "next: npm ci && npm run check"
          '';
        };
      }
    );
  };
}
