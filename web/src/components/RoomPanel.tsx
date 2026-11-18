import { useMemo, useState } from "react";
import {
  Eye,
  Hash,
  LoaderCircle,
  Megaphone,
  PenLine,
  RefreshCw,
  Save,
  Tags,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/ui/combobox";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorAlert } from "@/components/ErrorAlert";
import { usePartitions } from "@/hooks/usePartitions";
import { useRoom } from "@/hooks/useRoom";
import { errorMessage, type Area, type Room } from "@/lib/api";
import { formatCount } from "@/lib/format";

/** 开播状态徽标配色：0 未开播（灰）/ 1 直播中（绿）/ 2 轮播（黄） */
function LiveStatusBadge({ liveStatus, text }: { liveStatus: number; text: string }) {
  if (liveStatus === 1) {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/30">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        {text !== "" ? text : "直播中"}
      </Badge>
    );
  }
  if (liveStatus === 2) {
    return (
      <Badge className="bg-amber-500/15 text-amber-500 ring-1 ring-amber-500/30">
        <span className="size-1.5 rounded-full bg-amber-500" />
        {text !== "" ? text : "轮播中"}
      </Badge>
    );
  }
  return (
    <Badge className="bg-muted text-muted-foreground ring-1 ring-border">
      <span className="size-1.5 rounded-full bg-muted-foreground" />
      {text !== "" ? text : "未开播"}
    </Badge>
  );
}

/** 直播间信息：概览 + 标题 / 分区 / 公告三项写操作。 */
export function RoomPanel() {
  const { room, loading, saving, error, refresh, setTitle, setArea, setAnnouncement } = useRoom();
  const { areas, loading: areasLoading } = usePartitions();
  /** 保存成功后自增，用来重建编辑区（草稿回到服务端最新值） */
  const [revision, setRevision] = useState(0);

  async function handleSaveTitle(next: string) {
    const title = next.trim();
    if (title === "") {
      toast.error("标题不能为空");
      return;
    }
    try {
      await setTitle(title);
      setRevision((value) => value + 1);
      toast.success("标题已更新");
    } catch (cause: unknown) {
      toast.error("修改标题失败", { description: errorMessage(cause) });
    }
  }

  async function handleSaveArea(areaId: number) {
    try {
      await setArea(areaId);
      setRevision((value) => value + 1);
      toast.success("分区已更新");
    } catch (cause: unknown) {
      toast.error("修改分区失败", { description: errorMessage(cause) });
    }
  }

  async function handleSaveAnnouncement(content: string) {
    try {
      await setAnnouncement(content);
      setRevision((value) => value + 1);
      toast.success("公告已更新");
    } catch (cause: unknown) {
      toast.error("修改公告失败", { description: errorMessage(cause) });
    }
  }

  if (loading && room === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (room === null) {
    return (
      <div className="space-y-3">
        {error !== null ? <ErrorAlert title="获取房间信息失败" message={error} /> : null}
        <EmptyState
          icon={UserRound}
          title="还没有房间信息"
          description="通常是尚未登录，先去「登录」标签扫码登录。"
          action={
            <Button variant="outline" onClick={() => void refresh()}>
              <RefreshCw />
              重新获取
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error !== null ? <ErrorAlert title="获取房间信息失败" message={error} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {room.title}
            <LiveStatusBadge liveStatus={room.liveStatus} text={room.liveStatusText} />
          </CardTitle>
          <CardDescription>直播间实时概览，数据来自 /api/room。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon={Hash} label="房间号" value={String(room.roomId)} />
            <Stat icon={Hash} label="短号" value={String(room.shortId)} />
            <Stat icon={Tags} label="分区" value={room.areaName !== "" ? room.areaName : "—"} />
            <Stat icon={Eye} label="人气" value={formatCount(room.online)} />
          </div>
          <Separator />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              父分区 {room.parentAreaName !== "" ? room.parentAreaName : "—"} · UID {room.uid}
            </span>
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              刷新
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* key 变化时重建编辑区，草稿重新取自服务端数据 */}
      <RoomEditor
        key={String(room.roomId) + "-" + String(revision)}
        room={room}
        areas={areas}
        areasLoading={areasLoading}
        saving={saving}
        onSaveTitle={handleSaveTitle}
        onSaveArea={handleSaveArea}
        onSaveAnnouncement={handleSaveAnnouncement}
      />
    </div>
  );
}

interface RoomEditorProps {
  room: Room;
  areas: Area[];
  areasLoading: boolean;
  saving: boolean;
  onSaveTitle: (title: string) => Promise<void>;
  onSaveArea: (areaId: number) => Promise<void>;
  onSaveAnnouncement: (content: string) => Promise<void>;
}

/** 编辑区：标题 / 分区 / 公告。初始值直接来自 props，避免额外同步。 */
function RoomEditor({
  room,
  areas,
  areasLoading,
  saving,
  onSaveTitle,
  onSaveArea,
  onSaveAnnouncement,
}: RoomEditorProps) {
  const [titleDraft, setTitleDraft] = useState(room.title);
  const [announcementDraft, setAnnouncementDraft] = useState(room.description);
  const [parentAreaId, setParentAreaId] = useState(room.parentAreaId > 0 ? String(room.parentAreaId) : "");
  const [subAreaId, setSubAreaId] = useState(room.areaId > 0 ? String(room.areaId) : "");

  const subAreas = useMemo(() => {
    if (parentAreaId === "") {
      return [];
    }
    const parent = areas.find((area) => String(area.id) === parentAreaId);
    return parent?.list ?? [];
  }, [areas, parentAreaId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PenLine className="size-4" />
            修改标题
          </CardTitle>
          <CardDescription>提交后立即生效，接口 POST /api/title。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="room-title">直播间标题</Label>
            <Input
              id="room-title"
              value={titleDraft}
              maxLength={40}
              placeholder="今天聊点什么…"
              onChange={(event) => setTitleDraft(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{titleDraft.length} / 40</p>
          </div>
          <Button onClick={() => void onSaveTitle(titleDraft)} disabled={saving}>
            {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
            保存标题
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tags className="size-4" />
            修改分区
          </CardTitle>
          <CardDescription>先选一级分区，再选二级分区；提交接口 POST /api/area。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>一级分区</Label>
              <Combobox
                options={areas.map((area) => ({ value: String(area.id), label: area.name }))}
                value={parentAreaId}
                onChange={(value) => {
                  setParentAreaId(value);
                  setSubAreaId("");
                }}
                placeholder={areasLoading ? "加载中…" : "选择一级分区"}
                searchPlaceholder="搜索一级分区…"
                disabled={areasLoading}
              />
            </div>
            <div className="space-y-1.5">
              <Label>二级分区</Label>
              <Combobox
                options={subAreas.map((area) => ({ value: String(area.id), label: area.name }))}
                value={subAreaId}
                onChange={setSubAreaId}
                placeholder={parentAreaId === "" ? "先选一级分区" : "选择二级分区"}
                searchPlaceholder="搜索二级分区…"
                emptyText="没有匹配的二级分区"
                disabled={parentAreaId === "" || subAreas.length === 0}
              />
            </div>
          </div>
          <Button
            onClick={() => void onSaveArea(Number(subAreaId))}
            disabled={saving || subAreaId === ""}
          >
            {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
            保存分区
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="size-4" />
            修改公告
          </CardTitle>
          <CardDescription>公告显示在直播间简介位置，接口 POST /api/announcement。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            className="min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={announcementDraft}
            maxLength={200}
            placeholder="写点公告…"
            onChange={(event) => setAnnouncementDraft(event.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{announcementDraft.length} / 200</span>
            <Button onClick={() => void onSaveAnnouncement(announcementDraft)} disabled={saving}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
              保存公告
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface StatProps {
  icon: typeof Eye;
  label: string;
  value: string;
}

/** 概览小卡：图标 + 标题 + 值 */
function Stat({ icon: Icon, label, value }: StatProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="mt-1 truncate font-mono text-sm font-medium">{value}</p>
    </div>
  );
}
