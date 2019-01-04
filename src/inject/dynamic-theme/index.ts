import {replaceCSSVariables} from './css-rules';
import {overrideInlineStyles, getInlineOverrideStyle, watchForInlineStyles, stopWatchingForInlineStyles} from './inline-style';
import {getModifiedUserAgentStyle, getModifiedFallbackStyle, getSiteOverride, cleanModificationCache} from './modify-css';
import {manageStyle, shouldManageStyle, STYLE_SELECTOR, StyleManager} from './style-manager';
import {watchForStyleChanges, stopWatchingForStyleChanges} from './watch';
import {removeNode, watchForNodePosition} from '../utils/dom';
import {throttle} from '../utils/throttle';
import {clamp} from '../../utils/math';
import {isFirefox} from '../../utils/platform';
import {getCSSFilterValue} from '../../generators/css-filter';
import {createTextStyle} from '../../generators/text-style';
import {FilterConfig, DynamicThemeFix} from '../../definitions';

const styleManagers = new Map<HTMLLinkElement | HTMLStyleElement, StyleManager>();
const variables = new Map<string, string>();
let filter: FilterConfig = null;
let fixes: DynamicThemeFix = null;
let isIFrame: boolean = null;

function createOrUpdateStyle(className: string) {
    let style = document.head.querySelector(`.${className}`) as HTMLStyleElement;
    if (!style) {
        style = document.createElement('style');
        style.classList.add('darkreader');
        style.classList.add(className);
        style.media = 'screen';
    }
    return style;
}

const stylePositionWatchers = new Map<string, ReturnType<typeof watchForNodePosition>>();

function setupStylePositionWatcher(node: Node, alias: string) {
    stylePositionWatchers.has(alias) && stylePositionWatchers.get(alias).stop();
    stylePositionWatchers.set(alias, watchForNodePosition(node));
}

function stopStylePositionWatchers() {
    Array.from(stylePositionWatchers.values()).forEach((watcher) => watcher.stop());
    stylePositionWatchers.clear();
}

function createStaticStyleOverrides() {
    const fallbackStyle = createOrUpdateStyle('darkreader--fallback');
    document.head.insertBefore(fallbackStyle, document.head.firstChild);
    fallbackStyle.textContent = getModifiedFallbackStyle(filter, {strict: true});
    setupStylePositionWatcher(fallbackStyle, 'fallback');

    const userAgentStyle = createOrUpdateStyle('darkreader--user-agent');
    document.head.insertBefore(userAgentStyle, fallbackStyle.nextSibling);
    userAgentStyle.textContent = getModifiedUserAgentStyle(filter, isIFrame);
    setupStylePositionWatcher(userAgentStyle, 'user-agent');

    const textStyle = createOrUpdateStyle('darkreader--text');
    document.head.insertBefore(textStyle, fallbackStyle.nextSibling);
    if (filter.useFont || filter.textStroke > 0) {
        textStyle.textContent = createTextStyle(filter);
    } else {
        textStyle.textContent = '';
    }
    setupStylePositionWatcher(textStyle, 'text');

    const invertStyle = createOrUpdateStyle('darkreader--invert');
    document.head.insertBefore(invertStyle, textStyle.nextSibling);
    if (fixes && Array.isArray(fixes.invert) && fixes.invert.length > 0) {
        invertStyle.textContent = [
            `${fixes.invert.join(', ')} {`,
            `    filter: ${getCSSFilterValue({
                ...filter,
                contrast: filter.mode === 0 ? filter.contrast : clamp(filter.contrast - 10, 0, 100),
            })} !important;`,
            '}',
        ].join('\n');
    } else {
        invertStyle.textContent = '';
    }
    setupStylePositionWatcher(invertStyle, 'invert');

    const inlineStyle = createOrUpdateStyle('darkreader--inline');
    document.head.insertBefore(inlineStyle, invertStyle.nextSibling);
    inlineStyle.textContent = getInlineOverrideStyle();
    setupStylePositionWatcher(inlineStyle, 'inline');

    const overrideStyle = createOrUpdateStyle('darkreader--override');
    document.head.appendChild(overrideStyle);
    overrideStyle.textContent = getSiteOverride(location.host, filter);
    setupStylePositionWatcher(overrideStyle, 'override');
}

function cleanFallbackStyle() {
    const fallback = document.head.querySelector('.darkreader--fallback');
    if (fallback) {
        fallback.textContent = '';
    }
}

function createDynamicStyleOverrides() {
    cancelRendering();
    const newManagers = Array.from<HTMLLinkElement | HTMLStyleElement>(document.querySelectorAll(STYLE_SELECTOR))
        .filter((style) => !styleManagers.has(style) && shouldManageStyle(style))
        .map((style) => createManager(style));
    const newVariables = newManagers
        .map((manager) => manager.details())
        .filter((details) => details && details.variables.size > 0)
        .map(({variables}) => variables);
    if (newVariables.length === 0) {
        styleManagers.forEach((manager) => manager.render(filter, variables));
        if (loadingStyles.size === 0) {
            cleanFallbackStyle();
        }
    } else {
        newVariables.forEach((variables) => updateVariables(variables));
        throttledRenderAllStyles(() => {
            if (loadingStyles.size === 0) {
                cleanFallbackStyle();
            }
        });
    }
    newManagers.forEach((manager) => manager.watch());
    overrideInlineStyles(filter);
}

let loadingStylesCounter = 0;
const loadingStyles = new Set();

function createManager(element: HTMLLinkElement | HTMLStyleElement) {
    if (styleManagers.has(element)) {
        return;
    }

    let loadingStyleId = ++loadingStylesCounter;

    function loadingStart() {
        if (!isPageLoaded()) {
            loadingStyles.add(loadingStyleId);

            const fallbackStyle = document.querySelector('.darkreader--fallback');
            if (!fallbackStyle.textContent) {
                fallbackStyle.textContent = getModifiedFallbackStyle(filter, {strict: false});
            }
        }
    }

    function loadingEnd() {
        loadingStyles.delete(loadingStyleId);
        if (loadingStyles.size === 0 && isPageLoaded()) {
            cleanFallbackStyle();
        }
    }

    function update() {
        const details = manager.details();
        if (!details) {
            return;
        }
        if (details.variables.size === 0) {
            manager.render(filter, variables);
        } else {
            updateVariables(details.variables);
            throttledRenderAllStyles();
        }
    }

    const manager = manageStyle(element, {update, loadingStart, loadingEnd});
    styleManagers.set(element, manager);

    return manager;
}

function updateVariables(newVars: Map<string, string>) {
    if (newVars.size === 0) {
        return;
    }
    newVars.forEach((value, key) => variables.set(key, value));
    variables.forEach((value, key) => variables.set(key, replaceCSSVariables(value, variables)));
}

function removeManager(element: HTMLLinkElement | HTMLStyleElement) {
    const manager = styleManagers.get(element);
    if (manager) {
        manager.destroy();
        styleManagers.delete(element);
    }
}

const throttledRenderAllStyles = throttle((callback?: () => void) => {
    styleManagers.forEach((manager) => manager.render(filter, variables));
    callback && callback();
});
const cancelRendering = function () {
    throttledRenderAllStyles.cancel();
};

function isPageLoaded() {
    return document.readyState === 'complete' || document.readyState === 'interactive';
}

function onReadyStateChange() {
    if (!isPageLoaded()) {
        return;
    }
    document.removeEventListener('readystatechange', onReadyStateChange);
    if (loadingStyles.size === 0) {
        cleanFallbackStyle();
    }
}

let documentVisibilityListener: () => void = null;

function watchForDocumentVisibility(callback: () => void) {
    const alreadyWatching = Boolean(documentVisibilityListener);
    documentVisibilityListener = () => {
        if (!document.hidden) {
            stopWatchingForDocumentVisibility();
            callback();
        }
    };
    if (!alreadyWatching) {
        document.addEventListener('visibilitychange', documentVisibilityListener);
    }
}

function stopWatchingForDocumentVisibility() {
    document.removeEventListener('visibilitychange', documentVisibilityListener);
    documentVisibilityListener = null;
}

function createThemeAndWatchForUpdates() {
    createStaticStyleOverrides();

    if (document.hidden) {
        watchForDocumentVisibility(() => {
            createDynamicStyleOverrides();
            watchForUpdates();
        });
    } else {
        createDynamicStyleOverrides();
        watchForUpdates();
    }
}

function watchForUpdates() {
    watchForStyleChanges(({created, updated, removed}) => {
        const createdStyles = new Set(created);
        const movedStyles = new Set(removed.filter((style) => createdStyles.has(style)));
        removed
            .filter((style) => !movedStyles.has(style))
            .forEach((style) => removeManager(style));
        const newManagers = Array.from(new Set(created.concat(updated)))
            .filter((style) => !styleManagers.has(style))
            .map((style) => createManager(style));
        const newVariables = newManagers
            .map((manager) => manager.details())
            .filter((details) => details && details.variables.size > 0)
            .map(({variables}) => variables);
        if (newVariables.length === 0) {
            newManagers.forEach((manager) => manager.render(filter, variables));
        } else {
            newVariables.forEach((variables) => updateVariables(variables));
            throttledRenderAllStyles();
        }
        newManagers.forEach((manager) => manager.watch());
    });
    watchForInlineStyles(filter);

    document.addEventListener('readystatechange', onReadyStateChange);
}

function stopWatchingForUpdates() {
    styleManagers.forEach((manager) => manager.pause());
    stopStylePositionWatchers();
    stopWatchingForStyleChanges();
    stopWatchingForInlineStyles();
    document.removeEventListener('readystatechange', onReadyStateChange);
}

export function createOrUpdateDynamicTheme(filterConfig: FilterConfig, dynamicThemeFixes: DynamicThemeFix, iframe: boolean) {
    filter = filterConfig;
    fixes = dynamicThemeFixes;
    isIFrame = iframe;
    if (document.head) {
        createThemeAndWatchForUpdates();
    } else {
        if (!isFirefox()) {
            const fallbackStyle = createOrUpdateStyle('darkreader--fallback');
            document.documentElement.appendChild(fallbackStyle);
            fallbackStyle.textContent = getModifiedFallbackStyle(filter, {strict: true});
        }

        const headObserver = new MutationObserver(() => {
            if (document.head) {
                headObserver.disconnect();
                createThemeAndWatchForUpdates();
            }
        });
        headObserver.observe(document, {childList: true, subtree: true});
    }
}

export function removeDynamicTheme() {
    cleanDynamicThemeCache();
    removeNode(document.querySelector('.darkreader--fallback'));
    if (document.head) {
        removeNode(document.head.querySelector('.darkreader--user-agent'));
        removeNode(document.head.querySelector('.darkreader--text'));
        removeNode(document.head.querySelector('.darkreader--invert'));
        removeNode(document.head.querySelector('.darkreader--inline'));
        removeNode(document.head.querySelector('.darkreader--override'));
    }
    Array.from(styleManagers.keys()).forEach((el) => removeManager(el));
    Array.from(document.querySelectorAll('.darkreader')).forEach(removeNode);
}

export function cleanDynamicThemeCache() {
    stopWatchingForDocumentVisibility();
    cancelRendering();
    stopWatchingForUpdates();
    cleanModificationCache();
}
