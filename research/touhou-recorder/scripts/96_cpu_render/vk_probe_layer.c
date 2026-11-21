// th06ncのCPU描画の内訳を調べる最小のVulkanレイヤー(reports/96)。
// フレーム番号VKPROBE_START以降のVKPROBE_FRAMESフレームぶんの描画コマンドをVKPROBE_LOGへ書く。
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include <vulkan/vk_layer.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <pthread.h>

static PFN_vkGetInstanceProcAddr g_gipa;
static PFN_vkGetDeviceProcAddr g_gdpa;
static PFN_vkCreateImage n_CreateImage;
static PFN_vkCreateShaderModule n_CreateShaderModule;
static PFN_vkCreateGraphicsPipelines n_CreateGraphicsPipelines;
static PFN_vkCmdBeginRendering n_BeginRendering;
static PFN_vkCmdEndRendering n_EndRendering;
static PFN_vkCmdDraw n_Draw;
static PFN_vkCmdDrawIndexed n_DrawIndexed;
static PFN_vkCmdBindPipeline n_BindPipeline;
static PFN_vkCmdSetViewportWithCount n_SetViewportWithCount;
static PFN_vkCmdSetScissorWithCount n_SetScissorWithCount;
static PFN_vkCmdCopyImage2 n_CopyImage2;
static PFN_vkCmdBlitImage2 n_BlitImage2;
static PFN_vkCmdResolveImage2 n_ResolveImage2;
static PFN_vkCmdCopyBufferToImage2 n_CopyBufferToImage2;
static PFN_vkCmdCopyImageToBuffer2 n_CopyImageToBuffer2;
static PFN_vkQueuePresentKHR n_QueuePresent;
static PFN_vkQueueSubmit2 n_QueueSubmit2;
static PFN_vkQueueSubmit n_QueueSubmit;

static FILE *g_log;
static long g_frame, g_start = 300, g_count = 3;
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;

static void init_log(void) {
    if (g_log) return;
    const char *p = getenv("VKPROBE_LOG");
    g_log = fopen(p ? p : "/tmp/vkprobe.log", "w");
    if (getenv("VKPROBE_START")) g_start = atol(getenv("VKPROBE_START"));
    if (getenv("VKPROBE_FRAMES")) g_count = atol(getenv("VKPROBE_FRAMES"));
}
static int active(void) { return g_frame >= g_start && g_frame < g_start + g_count; }
#define LOGF(...) do { pthread_mutex_lock(&g_mu); fprintf(g_log, __VA_ARGS__); fflush(g_log); pthread_mutex_unlock(&g_mu); } while (0)

static VKAPI_ATTR VkResult VKAPI_CALL p_CreateImage(VkDevice d, const VkImageCreateInfo *i, const VkAllocationCallbacks *a, VkImage *o) {
    VkResult r = n_CreateImage(d, i, a, o);
    LOGF("IMAGE %p %ux%u fmt=%d samples=%d mips=%u layers=%u usage=0x%x (frame %ld)\n", (void *)*o, i->extent.width, i->extent.height,
         i->format, i->samples, i->mipLevels, i->arrayLayers, i->usage, g_frame);
    return r;
}
static VKAPI_ATTR VkResult VKAPI_CALL p_CreateShaderModule(VkDevice d, const VkShaderModuleCreateInfo *i, const VkAllocationCallbacks *a, VkShaderModule *o) {
    VkResult r = n_CreateShaderModule(d, i, a, o);
    unsigned long h = 5381;
    for (size_t k = 0; k < i->codeSize / 4; k++) h = h * 33 + i->pCode[k];
    LOGF("SHADERMOD %p size=%zu hash=%lx\n", (void *)*o, i->codeSize, h);
    return r;
}
static VKAPI_ATTR VkResult VKAPI_CALL p_CreateGraphicsPipelines(VkDevice d, VkPipelineCache c, uint32_t n, const VkGraphicsPipelineCreateInfo *ci, const VkAllocationCallbacks *a, VkPipeline *o) {
    VkResult r = n_CreateGraphicsPipelines(d, c, n, ci, a, o);
    for (uint32_t k = 0; k < n; k++) {
        const VkGraphicsPipelineCreateInfo *p = &ci[k];
        pthread_mutex_lock(&g_mu);
        fprintf(g_log, "PIPELINE %p", (void *)o[k]);
        for (uint32_t s = 0; s < p->stageCount; s++) fprintf(g_log, " stage%x=%p", p->pStages[s].stage, (void *)p->pStages[s].module);
        if (p->pMultisampleState) fprintf(g_log, " msaa=%d sampleShading=%d", p->pMultisampleState->rasterizationSamples, p->pMultisampleState->sampleShadingEnable);
        if (p->pColorBlendState && p->pColorBlendState->attachmentCount) {
            const VkPipelineColorBlendAttachmentState *b = p->pColorBlendState->pAttachments;
            fprintf(g_log, " blend=%d src=%d dst=%d", b->blendEnable, b->srcColorBlendFactor, b->dstColorBlendFactor);
        }
        fprintf(g_log, "\n"); fflush(g_log);
        pthread_mutex_unlock(&g_mu);
    }
    return r;
}
static VKAPI_ATTR void VKAPI_CALL p_BeginRendering(VkCommandBuffer cb, const VkRenderingInfo *i) {
    if (active()) {
        pthread_mutex_lock(&g_mu);
        fprintf(g_log, "  BEGINPASS area=%ux%u+%d+%d colors=%u", i->renderArea.extent.width, i->renderArea.extent.height, i->renderArea.offset.x, i->renderArea.offset.y, i->colorAttachmentCount);
        for (uint32_t k = 0; k < i->colorAttachmentCount; k++)
            fprintf(g_log, " view=%p load=%d store=%d resolve=%p", (void *)i->pColorAttachments[k].imageView, i->pColorAttachments[k].loadOp, i->pColorAttachments[k].storeOp, (void *)i->pColorAttachments[k].resolveImageView);
        fprintf(g_log, "\n"); fflush(g_log);
        pthread_mutex_unlock(&g_mu);
    }
    n_BeginRendering(cb, i);
}
static VKAPI_ATTR void VKAPI_CALL p_EndRendering(VkCommandBuffer cb) {
    if (active()) LOGF("  ENDPASS\n");
    n_EndRendering(cb);
}
static VKAPI_ATTR void VKAPI_CALL p_Draw(VkCommandBuffer cb, uint32_t v, uint32_t ins, uint32_t fv, uint32_t fi) {
    if (active()) LOGF("    DRAW verts=%u inst=%u first=%u\n", v, ins, fv);
    n_Draw(cb, v, ins, fv, fi);
}
static VKAPI_ATTR void VKAPI_CALL p_DrawIndexed(VkCommandBuffer cb, uint32_t c, uint32_t ins, uint32_t fi, int32_t vo, uint32_t fin) {
    if (active()) LOGF("    DRAWIDX idx=%u inst=%u\n", c, ins);
    n_DrawIndexed(cb, c, ins, fi, vo, fin);
}
static VKAPI_ATTR void VKAPI_CALL p_BindPipeline(VkCommandBuffer cb, VkPipelineBindPoint bp, VkPipeline p) {
    if (active()) LOGF("    BIND %p\n", (void *)p);
    n_BindPipeline(cb, bp, p);
}
static VKAPI_ATTR void VKAPI_CALL p_SetViewportWithCount(VkCommandBuffer cb, uint32_t n, const VkViewport *v) {
    if (active() && n) LOGF("    VIEWPORT %.0fx%.0f+%.0f+%.0f\n", v->width, v->height, v->x, v->y);
    n_SetViewportWithCount(cb, n, v);
}
static VKAPI_ATTR void VKAPI_CALL p_SetScissorWithCount(VkCommandBuffer cb, uint32_t n, const VkRect2D *s) {
    if (active() && n) LOGF("    SCISSOR %ux%u+%d+%d\n", s->extent.width, s->extent.height, s->offset.x, s->offset.y);
    n_SetScissorWithCount(cb, n, s);
}
static VKAPI_ATTR void VKAPI_CALL p_CopyImage2(VkCommandBuffer cb, const VkCopyImageInfo2 *i) {
    if (active()) LOGF("  COPYIMAGE %p->%p %ux%u\n", (void *)i->srcImage, (void *)i->dstImage, i->pRegions[0].extent.width, i->pRegions[0].extent.height);
    n_CopyImage2(cb, i);
}
static VKAPI_ATTR void VKAPI_CALL p_BlitImage2(VkCommandBuffer cb, const VkBlitImageInfo2 *i) {
    if (active()) LOGF("  BLIT %p->%p dst=%dx%d filter=%d\n", (void *)i->srcImage, (void *)i->dstImage, i->pRegions[0].dstOffsets[1].x, i->pRegions[0].dstOffsets[1].y, i->filter);
    n_BlitImage2(cb, i);
}
static VKAPI_ATTR void VKAPI_CALL p_ResolveImage2(VkCommandBuffer cb, const VkResolveImageInfo2 *i) {
    if (active()) LOGF("  RESOLVE %p->%p %ux%u\n", (void *)i->srcImage, (void *)i->dstImage, i->pRegions[0].extent.width, i->pRegions[0].extent.height);
    n_ResolveImage2(cb, i);
}
static VKAPI_ATTR void VKAPI_CALL p_CopyBufferToImage2(VkCommandBuffer cb, const VkCopyBufferToImageInfo2 *i) {
    if (active()) LOGF("  UPLOAD ->%p %ux%u\n", (void *)i->dstImage, i->pRegions[0].imageExtent.width, i->pRegions[0].imageExtent.height);
    n_CopyBufferToImage2(cb, i);
}
static VKAPI_ATTR void VKAPI_CALL p_CopyImageToBuffer2(VkCommandBuffer cb, const VkCopyImageToBufferInfo2 *i) {
    if (active()) LOGF("  READBACK %p %ux%u\n", (void *)i->srcImage, i->pRegions[0].imageExtent.width, i->pRegions[0].imageExtent.height);
    n_CopyImageToBuffer2(cb, i);
}
static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }
static VKAPI_ATTR VkResult VKAPI_CALL p_QueueSubmit2(VkQueue q, uint32_t n, const VkSubmitInfo2 *s, VkFence f) {
    double t = now_ms();
    VkResult r = n_QueueSubmit2(q, n, s, f);
    if (active()) LOGF("  SUBMIT2 n=%u %.2fms\n", n, now_ms() - t);
    return r;
}
static VKAPI_ATTR VkResult VKAPI_CALL p_QueueSubmit(VkQueue q, uint32_t n, const VkSubmitInfo *s, VkFence f) {
    double t = now_ms();
    VkResult r = n_QueueSubmit(q, n, s, f);
    if (active()) LOGF("  SUBMIT n=%u %.2fms\n", n, now_ms() - t);
    return r;
}
static VKAPI_ATTR VkResult VKAPI_CALL p_QueuePresent(VkQueue q, const VkPresentInfoKHR *i) {
    static double last;
    double t = now_ms();
    if (active()) LOGF("FRAME %ld interval=%.1fms\n", g_frame, t - last);
    last = t;
    VkResult r = n_QueuePresent(q, i);
    if (active()) LOGF("  PRESENTCALL %.2fms\n", now_ms() - t);
    g_frame++;
    return r;
}
static VKAPI_ATTR VkResult VKAPI_CALL p_CreateInstance(const VkInstanceCreateInfo *ci, const VkAllocationCallbacks *a, VkInstance *o) {
    init_log();
    VkLayerInstanceCreateInfo *l = (VkLayerInstanceCreateInfo *)ci->pNext;
    while (l && !(l->sType == VK_STRUCTURE_TYPE_LOADER_INSTANCE_CREATE_INFO && l->function == VK_LAYER_LINK_INFO)) l = (VkLayerInstanceCreateInfo *)l->pNext;
    if (!l) return VK_ERROR_INITIALIZATION_FAILED;
    g_gipa = l->u.pLayerInfo->pfnNextGetInstanceProcAddr;
    l->u.pLayerInfo = l->u.pLayerInfo->pNext;
    PFN_vkCreateInstance next = (PFN_vkCreateInstance)g_gipa(NULL, "vkCreateInstance");
    return next(ci, a, o);
}
static VKAPI_ATTR VkResult VKAPI_CALL p_CreateDevice(VkPhysicalDevice pd, const VkDeviceCreateInfo *ci, const VkAllocationCallbacks *a, VkDevice *o) {
    VkLayerDeviceCreateInfo *l = (VkLayerDeviceCreateInfo *)ci->pNext;
    while (l && !(l->sType == VK_STRUCTURE_TYPE_LOADER_DEVICE_CREATE_INFO && l->function == VK_LAYER_LINK_INFO)) l = (VkLayerDeviceCreateInfo *)l->pNext;
    if (!l) return VK_ERROR_INITIALIZATION_FAILED;
    PFN_vkGetInstanceProcAddr gipa = l->u.pLayerInfo->pfnNextGetInstanceProcAddr;
    g_gdpa = l->u.pLayerInfo->pfnNextGetDeviceProcAddr;
    l->u.pLayerInfo = l->u.pLayerInfo->pNext;
    PFN_vkCreateDevice next = (PFN_vkCreateDevice)gipa(VK_NULL_HANDLE, "vkCreateDevice");
    VkResult r = next(pd, ci, a, o);
    if (r != VK_SUCCESS) return r;
#define G(n) n_##n = (PFN_vk##n)g_gdpa(*o, "vk" #n)
    G(CreateImage); G(CreateShaderModule); G(CreateGraphicsPipelines); G(QueueSubmit2); G(QueueSubmit);
    n_BeginRendering = (PFN_vkCmdBeginRendering)g_gdpa(*o, "vkCmdBeginRendering");
    n_EndRendering = (PFN_vkCmdEndRendering)g_gdpa(*o, "vkCmdEndRendering");
    n_Draw = (PFN_vkCmdDraw)g_gdpa(*o, "vkCmdDraw"); n_DrawIndexed = (PFN_vkCmdDrawIndexed)g_gdpa(*o, "vkCmdDrawIndexed");
    n_BindPipeline = (PFN_vkCmdBindPipeline)g_gdpa(*o, "vkCmdBindPipeline");
    n_SetViewportWithCount = (PFN_vkCmdSetViewportWithCount)g_gdpa(*o, "vkCmdSetViewportWithCount");
    n_SetScissorWithCount = (PFN_vkCmdSetScissorWithCount)g_gdpa(*o, "vkCmdSetScissorWithCount");
    n_CopyImage2 = (PFN_vkCmdCopyImage2)g_gdpa(*o, "vkCmdCopyImage2"); n_BlitImage2 = (PFN_vkCmdBlitImage2)g_gdpa(*o, "vkCmdBlitImage2");
    n_ResolveImage2 = (PFN_vkCmdResolveImage2)g_gdpa(*o, "vkCmdResolveImage2");
    n_CopyBufferToImage2 = (PFN_vkCmdCopyBufferToImage2)g_gdpa(*o, "vkCmdCopyBufferToImage2");
    n_CopyImageToBuffer2 = (PFN_vkCmdCopyImageToBuffer2)g_gdpa(*o, "vkCmdCopyImageToBuffer2");
    n_QueuePresent = (PFN_vkQueuePresentKHR)g_gdpa(*o, "vkQueuePresentKHR");
    LOGF("DEVICE created\n");
    return r;
}
#define HOOK(s, f) if (!strcmp(n, "vk" s)) return (PFN_vkVoidFunction)f
static VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL p_GetDeviceProcAddr(VkDevice d, const char *n) {
    HOOK("GetDeviceProcAddr", p_GetDeviceProcAddr);
    HOOK("CreateImage", p_CreateImage); HOOK("CreateShaderModule", p_CreateShaderModule); HOOK("CreateGraphicsPipelines", p_CreateGraphicsPipelines);
    HOOK("CmdBeginRendering", p_BeginRendering); HOOK("CmdBeginRenderingKHR", p_BeginRendering);
    HOOK("CmdEndRendering", p_EndRendering); HOOK("CmdEndRenderingKHR", p_EndRendering);
    HOOK("CmdDraw", p_Draw); HOOK("CmdDrawIndexed", p_DrawIndexed); HOOK("CmdBindPipeline", p_BindPipeline);
    HOOK("CmdSetViewportWithCount", p_SetViewportWithCount); HOOK("CmdSetScissorWithCount", p_SetScissorWithCount);
    HOOK("CmdSetViewportWithCountEXT", p_SetViewportWithCount); HOOK("CmdSetScissorWithCountEXT", p_SetScissorWithCount);
    HOOK("CmdCopyImage2", p_CopyImage2); HOOK("CmdCopyImage2KHR", p_CopyImage2); HOOK("CmdBlitImage2", p_BlitImage2); HOOK("CmdBlitImage2KHR", p_BlitImage2);
    HOOK("CmdResolveImage2", p_ResolveImage2); HOOK("CmdResolveImage2KHR", p_ResolveImage2);
    HOOK("CmdCopyBufferToImage2", p_CopyBufferToImage2); HOOK("CmdCopyBufferToImage2KHR", p_CopyBufferToImage2);
    HOOK("CmdCopyImageToBuffer2", p_CopyImageToBuffer2); HOOK("CmdCopyImageToBuffer2KHR", p_CopyImageToBuffer2);
    HOOK("QueuePresentKHR", p_QueuePresent); HOOK("QueueSubmit2", p_QueueSubmit2); HOOK("QueueSubmit2KHR", p_QueueSubmit2); HOOK("QueueSubmit", p_QueueSubmit);
    return g_gdpa(d, n);
}
__attribute__((visibility("default"))) VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vkprobe_GetInstanceProcAddr(VkInstance i, const char *n) {
    HOOK("GetInstanceProcAddr", vkprobe_GetInstanceProcAddr);
    HOOK("CreateInstance", p_CreateInstance); HOOK("CreateDevice", p_CreateDevice); HOOK("GetDeviceProcAddr", p_GetDeviceProcAddr);
    return g_gipa ? g_gipa(i, n) : NULL;
}
__attribute__((visibility("default"))) VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vkprobe_GetDeviceProcAddr(VkDevice d, const char *n) { return p_GetDeviceProcAddr(d, n); }
