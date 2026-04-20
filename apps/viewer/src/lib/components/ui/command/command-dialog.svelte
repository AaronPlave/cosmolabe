<script lang="ts">
	import type { Snippet } from "svelte";
	import Command from "./command.svelte";
	import * as Dialog from "$lib/components/ui/dialog/index.js";
	import { cn } from "$lib/utils.js";

	let {
		open = $bindable(false),
		ref = $bindable(null),
		value = $bindable(""),
		title = "Command Palette",
		description = "Search for a command to run...",
		showCloseButton = false,
		shouldFilter,
		filter,
		onOpenChange,
		portalProps,
		children,
		class: className,
		...restProps
	}: {
		open?: boolean;
		ref?: any;
		value?: string;
		title?: string;
		description?: string;
		showCloseButton?: boolean;
		shouldFilter?: boolean;
		filter?: (value: string, search: string, keywords?: string[]) => number;
		onOpenChange?: (open: boolean) => void;
		portalProps?: any;
		children: Snippet;
		class?: string;
		[key: string]: any;
	} = $props();
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Header class="sr-only">
		<Dialog.Title>{title}</Dialog.Title>
		<Dialog.Description>{description}</Dialog.Description>
	</Dialog.Header>
	<Dialog.Content
		class={cn("rounded-xl! top-1/3 translate-y-0 overflow-hidden p-0", className)}
		{showCloseButton}
		{portalProps}
	>
		<Command {shouldFilter} {filter} bind:value bind:ref {children} {...restProps} />
	</Dialog.Content>
</Dialog.Root>
