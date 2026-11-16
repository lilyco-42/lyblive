import { Heart, Megaphone, MessageCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/** 联系方式与商用口径与 kuake-studio 保持一致 */
const CONTACTS = [
  { label: "微信", value: "lilyco42" },
  { label: "QQ", value: "1957374829" },
  { label: "B 站", value: "云枢智创 · uid 603079076" },
];

/**
 * 赞助与广告：二维码走同源静态资源（不加载远端脚本 / iframe）。
 * 广告位只画虚线占位框，不接受任何远端配置注入。
 */
export function SponsorCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Heart className="size-4" />
          赞助与广告
        </CardTitle>
        <CardDescription>
          本项目开源免费。赞助用于覆盖维护与服务器成本；赞助后可在「署名（fame）」与
          「商用权益（profit）」中二选一，作者按你的选择登记。广告位只做占位，不加载任何远端脚本。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <figure className="space-y-1.5">
            <img
              src="/assets/sponsor/wechat-contact.png"
              alt="微信联系方式二维码"
              className="w-full rounded-lg border border-border bg-white p-1.5"
            />
            <figcaption className="text-center text-xs text-muted-foreground">
              扫码加微信（备注 lyblive）
            </figcaption>
          </figure>
          <figure className="space-y-1.5">
            <img
              src="/assets/sponsor/wechat-pay.png"
              alt="赞助收款二维码"
              className="w-full rounded-lg border border-border bg-white p-1.5"
            />
            <figcaption className="text-center text-xs text-muted-foreground">
              扫码赞助（金额随意）
            </figcaption>
          </figure>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-2">
          <MessageCircle className="size-4 text-muted-foreground" />
          {CONTACTS.map((item) => (
            <Badge key={item.label} variant="outline">
              {item.label} {item.value}
            </Badge>
          ))}
        </div>

        <div
          data-slot="ad-about"
          className="flex min-h-14 items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-center text-xs text-muted-foreground"
        >
          <Badge variant="outline" className="text-[10px]">
            广告位
          </Badge>
          <Megaphone className="size-3.5" />
          <span>可放置你的直播相关服务推广（仅文字占位，不加载远端脚本）</span>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          许可：MIT。源码可见、个人可自由使用与修改；禁止二次贩卖 / 转售；商用（含付费或赞助后的商业使用）
          须获得作者 lilyco 授权。
        </p>
      </CardContent>
    </Card>
  );
}