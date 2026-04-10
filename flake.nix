{
  description = "aicoder-opencode control-plane dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, ... }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forEachSupportedSystem = function:
        nixpkgs.lib.genAttrs supportedSystems (system:
          function (import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          }));
    in
    {
      devShells = forEachSupportedSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.typescript
            pkgs.nodePackages_latest.pnpm
            pkgs.nodePackages_latest.typescript-language-server
            pkgs.yq
            pkgs.jq
            pkgs.just
            pkgs.bubblewrap
            pkgs.jujutsu
          ];

          shellHook = ''
            export PATH="$PWD/bin:$PATH"
            echo "aicoder-opencode dev shell"
          '';
        };
      });
    };
}
