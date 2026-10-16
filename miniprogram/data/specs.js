// Generated draft preview; never a release catalog.
module.exports = {
  "schemaVersion": 1,
  "version": "2026-10-16-draft",
  "updatedAt": "2026-10-16",
  "specs": [
    {
      "id": "yicun-print-example",
      "name": "一寸通用打印（草稿示例）",
      "enabled": false,
      "verification": "draft",
      "usage": "print",
      "pixels": {
        "width": 295,
        "height": 413,
        "minWidth": 295,
        "maxWidth": 295,
        "minHeight": 413,
        "maxHeight": 413,
        "aspectRatio": {
          "width": 5,
          "height": 7
        }
      },
      "print": {
        "widthMM": 25,
        "heightMM": 35,
        "dpi": 300
      },
      "file": {
        "format": "jpeg",
        "minBytes": null,
        "maxBytes": null
      },
      "backgrounds": [
        "#FFFFFF",
        "#438EDB",
        "#D93434"
      ],
      "placement": null,
      "scope": {
        "region": "通用打印",
        "year": null,
        "channel": "打印"
      },
      "source": {
        "type": "internal",
        "title": "内部演示约定：25×35mm，300dpi",
        "url": null,
        "checkedAt": "2026-10-16"
      },
      "updatedAt": "2026-10-16",
      "expiresAt": null,
      "editingPolicy": "pending_review",
      "notes": "仅用于配置与换算测试，不代表任何证件提交要求；审核后再启用。"
    },
    {
      "id": "us-visa-digital-example",
      "name": "美国签证电子照片（草稿示例）",
      "enabled": false,
      "verification": "draft",
      "usage": "digital",
      "pixels": {
        "width": 600,
        "height": 600,
        "minWidth": 600,
        "maxWidth": 1200,
        "minHeight": 600,
        "maxHeight": 1200,
        "aspectRatio": {
          "width": 1,
          "height": 1
        }
      },
      "print": null,
      "file": {
        "format": "jpeg",
        "minBytes": null,
        "maxBytes": 240000
      },
      "backgrounds": [
        "#FFFFFF"
      ],
      "placement": null,
      "scope": {
        "region": "美国",
        "year": 2026,
        "channel": "签证电子提交（具体表单待核验）"
      },
      "source": {
        "type": "official",
        "title": "美国国务院 Digital Image Requirements，适用表单与编辑政策待核验",
        "url": "https://travel.state.gov/content/travel/en/us-visas/visa-information-resources/photos/digital-image-requirements.html",
        "checkedAt": "2026-10-16"
      },
      "updatedAt": "2026-10-16",
      "expiresAt": null,
      "editingPolicy": "pending_review",
      "notes": "禁用示例。240000 仅为保守字节示例，需核实官方 KB 单位与实际表单；数字编辑 / AI 修改限制未完成评估，不能启用抠图流程。"
    },
    {
      "id": "nia-online-digital-example",
      "name": "出入境证件全程网办照片（草稿示例）",
      "enabled": false,
      "verification": "draft",
      "usage": "digital",
      "pixels": {
        "width": 600,
        "height": 800,
        "minWidth": 400,
        "maxWidth": 1000,
        "minHeight": 600,
        "maxHeight": 1500,
        "aspectRatio": {
          "width": 3,
          "height": 4
        }
      },
      "print": null,
      "file": {
        "format": "jpeg",
        "minBytes": null,
        "maxBytes": null
      },
      "backgrounds": [
        "#FFFFFF"
      ],
      "placement": null,
      "scope": {
        "region": "中国",
        "year": 2026,
        "channel": "全程网办（适用业务待核验）"
      },
      "source": {
        "type": "official",
        "title": "国家移民管理局照片规范，具体页面与完整要求待补齐",
        "url": "https://www.nia.gov.cn/",
        "checkedAt": "2026-10-16"
      },
      "updatedAt": "2026-10-16",
      "expiresAt": null,
      "editingPolicy": "pending_review",
      "notes": "禁用示例，展示范围像素与 3:4 比例；需补充直接来源、文件大小、完整头部位置要求及是否允许编辑的依据，不能推广为通用护照规格。"
    }
  ]
};
