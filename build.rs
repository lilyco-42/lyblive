use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = root.join("web").join("dist");
    let index = dist.join("index.html");
    println!("cargo:rerun-if-changed={}", dist.display());
    println!("cargo:rerun-if-changed={}", index.display());
    if !index.is_file() {
        std::fs::create_dir_all(&dist).expect("创建 web/dist 失败");
        std::fs::write(
            &index,
            "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>lyblive</title></head><body><p>Web 资源未构建，请在 web/ 目录执行 pnpm install 与 pnpm build。</p></body></html>\n",
        ).expect("写入占位 index.html 失败");
        println!(
            "cargo:warning=web/dist/index.html 缺失，已生成占位页；正式发布前请执行 pnpm build"
        );
    }
}
