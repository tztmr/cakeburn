import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  metadataBase: new URL("https://cakelisten-edking.ykkjttytcj.chatgpt.site"),
  alternates: { canonical: "/" },
  title: "CAKE Monitor · PancakeSwap 数据终端",
  description: "追踪 PancakeSwap 的协议活动、CAKE 产品销毁、净通缩、供应变化、治理提案与价格提醒。",
  icons: { icon: [{ url: "/cake-icon.png", type: "image/png", sizes: "512x512" }, { url: "/favicon.ico" }], shortcut: "/favicon.ico", apple: "/cake-icon.png" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
